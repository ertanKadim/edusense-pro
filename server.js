const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = './database.json';

if (!fs.existsSync('./public/recordings')) fs.mkdirSync('./public/recordings', { recursive: true });
if (!fs.existsSync('./public/materials'))  fs.mkdirSync('./public/materials',  { recursive: true });

const readDB = () => {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch(e) { console.error('[DB] Okuma hatası:', e.message); return { users: [], lessons: [], classes: [] }; }
};
const writeDB = (db) => {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
    catch(e) { console.error('[DB] Yazma hatası:', e.message); }
};

const _initDB     = readDB();
if (!_initDB.sessions)       { _initDB.sessions = {};       writeDB(_initDB); }
if (!_initDB.live_sessions)  { _initDB.live_sessions = [];  writeDB(_initDB); }
if (!_initDB.materials)      { _initDB.materials = [];      writeDB(_initDB); }
if (!_initDB.announcements)  { _initDB.announcements = [];  writeDB(_initDB); }
if (!_initDB.assignments)    { _initDB.assignments = [];    writeDB(_initDB); }
if (!_initDB.submissions)    { _initDB.submissions = [];    writeDB(_initDB); }

if (!fs.existsSync('./public/submissions'))  fs.mkdirSync('./public/submissions',  { recursive: true });
if (!fs.existsSync('./public/asgn-attach'))  fs.mkdirSync('./public/asgn-attach',  { recursive: true });
const sessions      = new Map(Object.entries(_initDB.sessions)); // token → username — kalıcı
const userSockets   = new Map(); // username → Set of socketIds
const roomStartTime = new Map(); // roomId → lesson start timestamp (ms)
const activeSessions = new Map(); // sessionId → { roomId, courseId, title, teacherUsername }

// Sunucu yeniden başladığında eski "active" session'ları "ended" yap
(function cleanupStaleSessions() {
    const db = readDB();
    let changed = false;
    (db.live_sessions || []).forEach(s => {
        if (s.status === 'active') { s.status = 'ended'; s.endedAt = new Date().toISOString(); changed = true; }
    });
    if (changed) writeDB(db);
})();

function saveSessions() {
    const db = readDB();
    db.sessions = Object.fromEntries(sessions);
    writeDB(db);
}

function requireAuth(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
    req.authUser = sessions.get(token);
    next();
}

function generateClassCode(prefix) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const p = (prefix || 'EDU').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'EDU';
    return p + '-' + code;
}

// ══════════════════════════════════════════════════════════════════════════════
//  REST API
// ══════════════════════════════════════════════════════════════════════════════

// GİRİŞ
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false });
    const db   = readDB();
    const user = db.users.find(u => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ success: false });
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, username);
    saveSessions();
    res.json({ success: true, user, token });
});

// ÇIKIŞ
app.post('/api/logout', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (token) { sessions.delete(token); saveSessions(); }
    res.json({ success: true });
});

// KULLANICI LİSTESİ (parola hariç)
app.get('/api/users', requireAuth, (req, res) => {
    const db = readDB();
    res.json(db.users.map(({ password, ...u }) => u));
});

// ŞİFRE DEĞİŞTİR
app.patch('/api/users/me/password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ success:false, message:'Tüm alanları doldurun.' });
    if (newPassword.length < 4) return res.status(400).json({ success:false, message:'Yeni şifre en az 4 karakter olmalı.' });
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(404).json({ success:false, message:'Kullanıcı bulunamadı.' });
    if (user.password !== currentPassword) return res.status(401).json({ success:false, message:'Mevcut şifre yanlış.' });
    user.password = newPassword;
    writeDB(db);
    res.json({ success:true });
});

// ÖĞRETMEN — kendi derslerini listele
app.get('/api/lessons/:teacher', requireAuth, (req, res) => {
    const db      = readDB();
    const lessons = db.lessons.filter(l => l.teacher === req.params.teacher);
    res.json(lessons);
});

// ÖĞRENCİ — herkese açık (replayAvailable:true) dersleri listele
app.get('/api/replays', requireAuth, (req, res) => {
    const db      = readDB();
    const replays = db.lessons.filter(l => l.replayAvailable === true);
    res.json(replays);
});

// ÖĞRETMEN — belirli bir dersin replay durumunu değiştir
app.patch('/api/lessons/:id/replay', requireAuth, (req, res) => {
    const db     = readDB();
    const lesson = db.lessons.find(l => String(l.id) === String(req.params.id));
    if (!lesson) return res.status(404).json({ success: false });
    lesson.replayAvailable = !!req.body.replayAvailable;
    writeDB(db);
    io.emit('replay-status-changed', { id: lesson.id, replayAvailable: lesson.replayAvailable });
    res.json({ success: true, lesson });
});

// ÖĞRETMEN — dersi sil
app.delete('/api/lessons/:id', requireAuth, (req, res) => {
    const db  = readDB();
    const idx = db.lessons.findIndex(l => String(l.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ success: false });
    db.lessons.splice(idx, 1);
    writeDB(db);
    io.emit('lesson-deleted', { id: req.params.id });
    res.json({ success: true });
});

// VİDEO KAYIT — yükle
app.post('/api/upload-recording/:id', requireAuth,
    express.raw({ type: '*/*', limit: '512mb' }),
    (req, res) => {
        const filename = `lesson_${req.params.id}.webm`;
        try {
            fs.writeFileSync(`./public/recordings/${filename}`, req.body);
            const db = readDB();
            const lesson = db.lessons.find(l => String(l.id) === String(req.params.id));
            if (lesson) { lesson.recording = filename; writeDB(db); }
            res.json({ success: true });
        } catch(e) {
            console.error('[Kayıt] Hata:', e.message);
            res.status(500).json({ success: false });
        }
    }
);

// ── SINIF YÖNETİMİ ──────────────────────────────────────────────────────────

// Sınıf listesi
app.get('/api/classes', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) db.classes = [];
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.role === 'teacher') {
        res.json(db.classes.filter(c => c.teacher === req.authUser));
    } else {
        res.json(db.classes.filter(c =>
            (c.students || []).includes(req.authUser) ||
            (c.pendingRequests || []).some(r => r.username === req.authUser)
        ));
    }
});

// Sınıf oluştur (öğretmen)
app.post('/api/classes', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) db.classes = [];
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const { name, code, classInfo, color, icon, desc } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const prefix = (code || name).replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4) || 'EDU';
    const joinCode = generateClassCode(prefix);
    const newClass = {
        id: 'c_' + Date.now(),
        name,
        code: code || '',
        classInfo: classInfo || '',
        teacher: req.authUser,
        teacherName: user.name || req.authUser,
        color: color || '#6366f1',
        icon: icon || '📚',
        desc: desc || '',
        schedule: {},
        joinCode,
        students: [],
        pendingRequests: [],
        createdAt: new Date().toISOString()
    };
    db.classes.push(newClass);
    writeDB(db);
    res.json({ success: true, class: newClass });
});

// Katılım isteği gönder (öğrenci)
app.post('/api/classes/join', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) db.classes = [];
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'student') return res.status(403).json({ error: 'Forbidden' });
    const { joinCode } = req.body;
    if (!joinCode) return res.status(400).json({ error: 'Join code required' });
    const cls = db.classes.find(c => c.joinCode && c.joinCode.toUpperCase() === joinCode.toUpperCase().trim());
    if (!cls) return res.status(404).json({ error: 'Not found', message: 'Geçersiz katılım kodu.' });
    if ((cls.students || []).includes(req.authUser))
        return res.status(409).json({ error: 'Already enrolled', message: 'Zaten bu sınıfa kayıtlısınız.' });
    if ((cls.pendingRequests || []).some(r => r.username === req.authUser))
        return res.status(409).json({ error: 'Already pending', message: 'Katılım isteğiniz zaten bekleniyor.' });
    if (!cls.pendingRequests) cls.pendingRequests = [];
    const reqId = 'req_' + Date.now();
    const joinReq = { id: reqId, username: req.authUser, name: user.name || req.authUser, requestedAt: new Date().toISOString() };
    cls.pendingRequests.push(joinReq);
    writeDB(db);
    // Socket ile öğretmene bildir
    const teacherSids = userSockets.get(cls.teacher);
    if (teacherSids) {
        teacherSids.forEach(sid => io.to(sid).emit('join-request', { classId: cls.id, className: cls.name, request: joinReq }));
    }
    res.json({ success: true, classId: cls.id, className: cls.name, reqId });
});

// Katılım isteğini onayla (öğretmen)
app.post('/api/classes/:id/approve/:reqId', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) return res.status(404).json({ error: 'Not found' });
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = db.classes.find(c => c.id === req.params.id && c.teacher === req.authUser);
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    const reqIdx = (cls.pendingRequests || []).findIndex(r => r.id === req.params.reqId);
    if (reqIdx === -1) return res.status(404).json({ error: 'Request not found' });
    const [joinReq] = cls.pendingRequests.splice(reqIdx, 1);
    if (!cls.students) cls.students = [];
    if (!cls.students.includes(joinReq.username)) cls.students.push(joinReq.username);
    writeDB(db);
    const studentSids = userSockets.get(joinReq.username);
    if (studentSids) {
        studentSids.forEach(sid => io.to(sid).emit('join-approved', { classId: cls.id, className: cls.name }));
    }
    res.json({ success: true, class: cls });
});

// Katılım isteğini reddet (öğretmen)
app.post('/api/classes/:id/reject/:reqId', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) return res.status(404).json({ error: 'Not found' });
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = db.classes.find(c => c.id === req.params.id && c.teacher === req.authUser);
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    const reqIdx = (cls.pendingRequests || []).findIndex(r => r.id === req.params.reqId);
    if (reqIdx === -1) return res.status(404).json({ error: 'Request not found' });
    const [joinReq] = cls.pendingRequests.splice(reqIdx, 1);
    writeDB(db);
    const studentSids = userSockets.get(joinReq.username);
    if (studentSids) {
        studentSids.forEach(sid => io.to(sid).emit('join-rejected', { classId: cls.id, className: cls.name }));
    }
    res.json({ success: true });
});

// Sınıfı güncelle (öğretmen) — gün, saat ve temel bilgiler
app.patch('/api/classes/:id', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) return res.status(404).json({ error: 'Not found' });
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = db.classes.find(c => c.id === req.params.id && c.teacher === req.authUser);
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    const allowed = ['name','code','classInfo','icon','desc','color'];
    allowed.forEach(k => { if (req.body[k] !== undefined) cls[k] = req.body[k]; });
    if (req.body.schedule !== undefined && typeof req.body.schedule === 'object') {
        cls.schedule = req.body.schedule;
        // clean up legacy fields
        delete cls.days; delete cls.day; delete cls.time;
    }
    writeDB(db);
    res.json({ success: true, class: cls });
});

// Sınıfı sil (öğretmen)
app.delete('/api/classes/:id', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) return res.status(404).json({ error: 'Not found' });
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const idx = db.classes.findIndex(c => c.id === req.params.id && c.teacher === req.authUser);
    if (idx === -1) return res.status(404).json({ error: 'Class not found' });
    db.classes.splice(idx, 1);
    writeDB(db);
    res.json({ success: true });
});

// Öğrenciyi sınıftan çıkar (öğretmen)
app.delete('/api/classes/:id/students/:username', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) return res.status(404).json({ error: 'Not found' });
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = db.classes.find(c => c.id === req.params.id && c.teacher === req.authUser);
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    cls.students = (cls.students || []).filter(u => u !== req.params.username);
    writeDB(db);
    res.json({ success: true, class: cls });
});

// ── DUYURU YÖNETİMİ ──────────────────────────────────────────────────────────

// Duyuruları listele (öğretmen veya kayıtlı öğrenci)
app.get('/api/classes/:id/announcements', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const cls = (db.classes || []).find(c => c.id === req.params.id);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (!isOwner && !isStudent) return res.status(403).json({ error: 'Forbidden' });
    const anns = (db.announcements || []).filter(a => a.courseId === req.params.id);
    res.json(anns.slice().reverse()); // en yeni önce
});

// Duyuru oluştur (öğretmen)
app.post('/api/classes/:id/announcements', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = (db.classes || []).find(c => c.id === req.params.id && c.teacher === req.authUser);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    const { title, content, type, date, pinned } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    if (!db.announcements) db.announcements = [];
    const ann = {
        id: 'ann_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        courseId: req.params.id,
        title,
        content: content || '',
        type: type || 'genel',
        date: date || null,
        pinned: !!pinned,
        createdBy: req.authUser,
        at: new Date().toISOString()
    };
    db.announcements.push(ann);
    writeDB(db);
    // Kayıtlı öğrencilere socket bildirimi
    (cls.students || []).forEach(username => {
        const sids = userSockets.get(username);
        if (sids) sids.forEach(sid => io.to(sid).emit('course-notification', {
            type: 'new-ann',
            title: '📢 Yeni Duyuru: ' + title,
            body: (content || '').slice(0, 80),
            courseId: cls.id,
            courseName: cls.name,
            icon: '📢',
            unreadType: 'ann'
        }));
    });
    res.json({ success: true, announcement: ann });
});

// Duyuru sil (öğretmen)
app.delete('/api/classes/:id/announcements/:annId', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = (db.classes || []).find(c => c.id === req.params.id && c.teacher === req.authUser);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    if (!db.announcements) return res.status(404).json({ error: 'Not found' });
    const idx = db.announcements.findIndex(a => a.id === req.params.annId && a.courseId === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.announcements.splice(idx, 1);
    writeDB(db);
    res.json({ success: true });
});

// ── TOKEN & GAMIFICATION ──────────────────────────────────────────────────────

const DEFAULT_TOKEN_CONFIG = {
    lesson_join: 10, lesson_80pct: 10, camera_on: 5,
    quiz_complete: 15, quiz_high_score: 20,
    assignment_submit: 20, replay_watch: 10, interactive_activity: 10
};

const STORE_ITEMS_DEF = [
    { id:'s_bronze_frame',  name:'Bronz Çerçeve',          icon:'🟫', price:50,   category:'frame',   desc:'Profiline bronz çerçeve ekle' },
    { id:'s_silver_frame',  name:'Gümüş Çerçeve',          icon:'⚪', price:100,  category:'frame',   desc:'Profiline gümüş çerçeve ekle' },
    { id:'s_gold_frame',    name:'Altın Çerçeve',           icon:'🟡', price:250,  category:'frame',   desc:'Nadiren görülen altın çerçeve' },
    { id:'s_diamond_frame', name:'Elmas Çerçeve',           icon:'💎', price:500,  category:'frame',   desc:'En prestijli çerçeve' },
    { id:'s_edu_title',     name:'Eğitim Lideri Ünvanı',   icon:'👑', price:500,  category:'title',   desc:'Özel "Eğitim Lideri" ünvanı' },
    { id:'s_quiz_title',    name:'Quiz Şampiyonu Ünvanı',  icon:'🧠', price:350,  category:'title',   desc:'Özel quiz ünvanı' },
    { id:'s_legend_pack',   name:'Efsane Öğrenci Paketi',  icon:'🎁', price:1000, category:'pack',    desc:'Tüm premium özellikleri içerir' },
    { id:'s_cert',          name:'Dijital Sertifika',       icon:'📜', price:200,  category:'cert',    desc:'Başarı sertifikası' },
    { id:'s_theme_space',   name:'Uzay Teması',             icon:'🚀', price:75,   category:'theme',   desc:'Uzay temalı profil' },
    { id:'s_theme_nature',  name:'Doğa Teması',             icon:'🌿', price:75,   category:'theme',   desc:'Doğa temalı profil' },
    { id:'s_week_star',     name:'Haftanın Öğrencisi',      icon:'🌟', price:300,  category:'special', desc:'1 hafta vitrin öğrencisi' },
    { id:'s_anim_sparkle',  name:'Parıltı Efekti',          icon:'✨', price:150,  category:'effect',  desc:'Animasyonlu profil efekti' },
];

// Token bakiyesi ve geçmişi
app.get('/api/tokens/:username', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.tokenLedger) db.tokenLedger = [];
    if (req.authUser !== req.params.username) {
        const u = db.users.find(u => u.username === req.authUser);
        if (!u || u.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    }
    const ledger = db.tokenLedger.filter(t => t.username === req.params.username);
    const total  = ledger.reduce((s,t) => s + t.amount, 0);
    res.json({ username: req.params.username, total, ledger: ledger.slice(-100).reverse() });
});

// Token ver (tek)
app.post('/api/tokens/award', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.tokenLedger) db.tokenLedger = [];
    const awarder = db.users.find(u => u.username === req.authUser);
    if (!awarder || awarder.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const { username, amount, type, reason, classId, lessonId } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'Missing fields' });
    const student = db.users.find(u => u.username === username);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const entry = {
        id: 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
        username, amount: parseInt(amount),
        type: type || 'manual',
        reason: reason || '',
        fromUser: req.authUser,
        classId: classId || null, lessonId: lessonId || null,
        timestamp: new Date().toISOString()
    };
    db.tokenLedger.push(entry);
    writeDB(db);
    const total = db.tokenLedger.filter(t => t.username === username).reduce((s,t) => s + t.amount, 0);
    const sids = userSockets.get(username);
    if (sids) sids.forEach(sid => io.to(sid).emit('tokens-awarded', { amount: entry.amount, type: entry.type, reason: entry.reason, total }));
    res.json({ success: true, entry, total });
});

// Token ver (toplu - sistem için)
app.post('/api/tokens/award-system', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.tokenLedger) db.tokenLedger = [];
    const { username, amount, type, reason } = req.body;
    if (!username || !amount) return res.status(400).json({ error: 'Missing fields' });
    const student = db.users.find(u => u.username === username);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const entry = {
        id: 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
        username, amount: parseInt(amount),
        type: type || 'system',
        reason: reason || '',
        fromUser: 'system',
        classId: null, lessonId: null,
        timestamp: new Date().toISOString()
    };
    db.tokenLedger.push(entry);
    writeDB(db);
    const total = db.tokenLedger.filter(t => t.username === username).reduce((s,t) => s + t.amount, 0);
    const sids = userSockets.get(username);
    if (sids) sids.forEach(sid => io.to(sid).emit('tokens-awarded', { amount: entry.amount, type: entry.type, reason: entry.reason, total }));
    res.json({ success: true, entry, total });
});

// Token toplu ver (ders sonu)
app.post('/api/tokens/award-bulk', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.tokenLedger) db.tokenLedger = [];
    const awarder = db.users.find(u => u.username === req.authUser);
    if (!awarder || awarder.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const { awards, classId, lessonId } = req.body;
    if (!Array.isArray(awards)) return res.status(400).json({ error: 'Invalid' });
    const results = [];
    awards.forEach(({ username, amount, reason }) => {
        if (!username || !amount) return;
        const student = db.users.find(u => u.username === username);
        if (!student || parseInt(amount) === 0) return;
        const entry = {
            id: 'txn_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
            username, amount: parseInt(amount),
            type: 'manual', reason: reason || 'Öğretmen tarafından verildi',
            fromUser: req.authUser, classId: classId || null, lessonId: lessonId || null,
            timestamp: new Date().toISOString()
        };
        db.tokenLedger.push(entry);
        results.push(entry);
        const total = db.tokenLedger.filter(t => t.username === username).reduce((s,t) => s + t.amount, 0);
        const sids = userSockets.get(username);
        if (sids) sids.forEach(sid => io.to(sid).emit('tokens-awarded', { amount: entry.amount, type: 'manual', reason: entry.reason, total }));
    });
    writeDB(db);
    res.json({ success: true, count: results.length });
});

// Sınıf liderlik tablosu
app.get('/api/leaderboard/:classId', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.classes) db.classes = [];
    if (!db.tokenLedger) db.tokenLedger = [];
    const cls = db.classes.find(c => c.id === req.params.classId);
    if (!cls) return res.status(404).json({ error: 'Not found' });
    const students = cls.students || [];
    const board = students.map(username => {
        const ledger = db.tokenLedger.filter(t => t.username === username);
        const total  = ledger.reduce((s,t) => s + t.amount, 0);
        const user   = db.users.find(u => u.username === username);
        const txnCount = ledger.filter(t => t.type === 'manual').length;
        return { username, name: user?.name || username, total, manualCount: txnCount };
    }).sort((a,b) => b.total - a.total);
    res.json(board);
});

// Token konfigürasyon
app.get('/api/token-config', requireAuth, (req, res) => {
    const db = readDB();
    res.json({ ...DEFAULT_TOKEN_CONFIG, ...(db.tokenConfig || {}) });
});

app.patch('/api/token-config', requireAuth, (req, res) => {
    const db = readDB();
    const u = db.users.find(u => u.username === req.authUser);
    if (!u || u.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    if (!db.tokenConfig) db.tokenConfig = {};
    const allowed = Object.keys(DEFAULT_TOKEN_CONFIG);
    allowed.forEach(k => { if (req.body[k] !== undefined) db.tokenConfig[k] = parseInt(req.body[k]) || 0; });
    writeDB(db);
    res.json({ success: true, config: { ...DEFAULT_TOKEN_CONFIG, ...db.tokenConfig } });
});

// Mağaza
app.get('/api/store/items', requireAuth, (req, res) => res.json(STORE_ITEMS_DEF));

app.get('/api/store/purchases/:username', requireAuth, (req, res) => {
    const db = readDB();
    if (req.authUser !== req.params.username) {
        const u = db.users.find(u => u.username === req.authUser);
        if (!u || u.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    }
    res.json((db.storePurchases || []).filter(p => p.username === req.params.username));
});

app.post('/api/store/purchase', requireAuth, (req, res) => {
    const db = readDB();
    if (!db.tokenLedger) db.tokenLedger = [];
    if (!db.storePurchases) db.storePurchases = [];
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'student') return res.status(403).json({ error: 'Forbidden' });
    const { itemId } = req.body;
    const item = STORE_ITEMS_DEF.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (db.storePurchases.some(p => p.username === req.authUser && p.itemId === itemId))
        return res.status(409).json({ error: 'Already purchased' });
    const balance = db.tokenLedger.filter(t => t.username === req.authUser).reduce((s,t) => s + t.amount, 0);
    if (balance < item.price) return res.status(400).json({ error: 'Insufficient tokens', balance, required: item.price });
    db.tokenLedger.push({
        id: 'txn_' + Date.now(), username: req.authUser,
        amount: -item.price, type: 'purchase',
        reason: `Mağaza: ${item.name}`, fromUser: 'system',
        timestamp: new Date().toISOString()
    });
    db.storePurchases.push({
        id: 'pur_' + Date.now(), username: req.authUser,
        itemId, itemName: item.name, price: item.price,
        timestamp: new Date().toISOString()
    });
    writeDB(db);
    res.json({ success: true, newBalance: balance - item.price });
});

// ── CANLI DERS YÖNETİMİ ─────────────────────────────────────────────────────

// Öğrencinin kayıtlı olduğu derslerdeki aktif canlı oturumları listele
app.get('/api/live-sessions/active', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const db_sessions = db.live_sessions || [];
    if (user.role === 'student') {
        const enrolledIds = (db.classes || [])
            .filter(c => (c.students || []).includes(req.authUser))
            .map(c => c.id);
        const active = db_sessions.filter(s => s.status === 'active' && enrolledIds.includes(s.courseId));
        const result = active.map(s => {
            const course = (db.classes || []).find(c => c.id === s.courseId);
            return { ...s, courseName: course ? course.name : s.courseId, courseColor: course ? course.color : '#6366f1', courseIcon: course ? course.icon : '📚' };
        });
        return res.json(result);
    }
    // Teacher: aktif kendi derslerindeki oturumlar
    const myCourseIds = (db.classes || []).filter(c => c.teacher === req.authUser).map(c => c.id);
    const active = db_sessions.filter(s => s.status === 'active' && myCourseIds.includes(s.courseId));
    res.json(active);
});

// Belirli bir derse ait tüm canlı oturumlar (aktif + geçmiş)
app.get('/api/courses/:courseId/live-sessions', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    // Yetki: öğretmen sahibi veya kayıtlı öğrenci
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (!isOwner && !isStudent) return res.status(403).json({ error: 'Forbidden' });
    const sessions_list = (db.live_sessions || []).filter(s => s.courseId === req.params.courseId);
    res.json(sessions_list.slice().reverse());
});

// Ders kaydı ile canlı ders oturumunu getir (courseId'ye göre)
app.get('/api/courses/:courseId/recordings', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (!isOwner && !isStudent) return res.status(403).json({ error: 'Forbidden' });
    const lessons = (db.lessons || []).filter(l => l.courseId === req.params.courseId);
    if (isStudent) return res.json(lessons.filter(l => l.replayAvailable));
    res.json(lessons);
});

// ── TAKVİM YÖNETİMİ ─────────────────────────────────────────────────────────

// Takvim etkinliklerini listele (öğretmen + kayıtlı öğrenci)
app.get('/api/courses/:courseId/calendar', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (!isOwner && !isStudent) return res.status(403).json({ error: 'Forbidden' });
    const events = (db.calendarEvents || []).filter(e => e.courseId === req.params.courseId);
    res.json(events);
});

// Takvim etkinliği ekle (öğretmen)
app.post('/api/courses/:courseId/calendar', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls || cls.teacher !== req.authUser) return res.status(403).json({ error: 'Forbidden' });
    const { title, date, type } = req.body;
    if (!title || !date) return res.status(400).json({ error: 'Title and date required' });
    if (!db.calendarEvents) db.calendarEvents = [];
    const event = {
        id: 'cal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        courseId: req.params.courseId,
        title,
        date,
        type: type || 'lesson',
        createdBy: req.authUser,
        createdAt: new Date().toISOString()
    };
    db.calendarEvents.push(event);
    writeDB(db);
    res.json({ success: true, event });
});

// Takvim etkinliği sil (öğretmen)
app.delete('/api/courses/:courseId/calendar/:eventId', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls || cls.teacher !== req.authUser) return res.status(403).json({ error: 'Forbidden' });
    if (!db.calendarEvents) return res.status(404).json({ error: 'Not found' });
    const idx = db.calendarEvents.findIndex(e => e.id === req.params.eventId && e.courseId === req.params.courseId);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.calendarEvents.splice(idx, 1);
    writeDB(db);
    res.json({ success: true });
});

// ── MATERYAL YÖNETİMİ ────────────────────────────────────────────────────────

// Materyal listesi
app.get('/api/courses/:courseId/materials', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls) return res.status(404).json({ error: 'Course not found' });
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (!isOwner && !isStudent) return res.status(403).json({ error: 'Forbidden' });
    const mats = (db.materials || [])
        .filter(m => m.courseId === req.params.courseId)
        .slice().reverse(); // en yeni önce
    res.json(mats);
});

// Materyal yükle (öğretmen)
app.post('/api/courses/:courseId/materials',
    requireAuth,
    express.raw({ type: '*/*', limit: '200mb' }),
    (req, res) => {
        const db = readDB();
        const user = db.users.find(u => u.username === req.authUser);
        if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
        const cls = (db.classes || []).find(c => c.id === req.params.courseId);
        if (!cls || cls.teacher !== req.authUser) return res.status(403).json({ error: 'Forbidden' });

        const originalName = decodeURIComponent(req.headers['x-material-filename'] || 'dosya');
        const title        = decodeURIComponent(req.headers['x-material-title']    || originalName);
        const ext          = path.extname(originalName).toLowerCase().slice(1);
        const matId        = 'mat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const storedName   = `${matId}.${ext || 'bin'}`;

        try {
            fs.writeFileSync(`./public/materials/${storedName}`, req.body);
            if (!db.materials) db.materials = [];
            const entry = {
                id:           matId,
                courseId:     req.params.courseId,
                teacher:      req.authUser,
                title,
                originalName,
                filename:     storedName,
                ext:          ext || '',
                fileSize:     req.body.length,
                mimeType:     req.headers['content-type'] || 'application/octet-stream',
                uploadedAt:   new Date().toISOString()
            };
            db.materials.push(entry);
            writeDB(db);
            // Kayıtlı öğrencilere bildir
            (cls.students || []).forEach(username => {
                const sids = userSockets.get(username);
                if (sids) sids.forEach(sid => io.to(sid).emit('material-added', {
                    courseId: cls.id, courseName: cls.name, material: entry
                }));
            });
            res.json({ success: true, material: entry });
        } catch (e) {
            console.error('[Materyal] Yükleme hatası:', e.message);
            res.status(500).json({ error: 'Upload failed' });
        }
    }
);

// Materyal sil (öğretmen)
app.delete('/api/courses/:courseId/materials/:materialId', requireAuth, (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user || user.role !== 'teacher') return res.status(403).json({ error: 'Forbidden' });
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls || cls.teacher !== req.authUser) return res.status(403).json({ error: 'Forbidden' });
    if (!db.materials) db.materials = [];
    const idx = db.materials.findIndex(m => m.id === req.params.materialId && m.courseId === req.params.courseId);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const [mat] = db.materials.splice(idx, 1);
    writeDB(db);
    try { fs.unlinkSync(`./public/materials/${mat.filename}`); } catch(e) {}
    res.json({ success: true });
});

// ── ÖDEV & TESLİM YÖNETİMİ ───────────────────────────────────────────────────

function _asgnAuth(req, res, role) {
    const db   = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return { err: res.status(401).json({ error: 'Unauthorized' }) };
    const cls  = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls)  return { err: res.status(404).json({ error: 'Course not found' }) };
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (role === 'teacher' && !isOwner)             return { err: res.status(403).json({ error: 'Forbidden' }) };
    if (role === 'member'  && !isOwner && !isStudent) return { err: res.status(403).json({ error: 'Forbidden' }) };
    return { db, user, cls, isOwner, isStudent };
}

// Ödevleri listele
app.get('/api/courses/:courseId/assignments', requireAuth, (req, res) => {
    const { err, db } = _asgnAuth(req, res, 'member');
    if (err) return;
    const asgns = (db.assignments || []).filter(a => a.courseId === req.params.courseId);
    res.json(asgns.slice().reverse());
});

// Ödev oluştur (öğretmen, JSON)
app.post('/api/courses/:courseId/assignments', requireAuth, (req, res) => {
    const { err, db, cls } = _asgnAuth(req, res, 'teacher');
    if (err) return;
    if (!db.assignments) db.assignments = [];
    const { title, due, desc, maxGrade } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const asgn = {
        id: 'asgn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        courseId: req.params.courseId,
        title, due: due || null, desc: desc || '',
        maxGrade: maxGrade ? Math.max(1, Number(maxGrade)) : 100,
        createdBy: req.authUser,
        at: new Date().toISOString(),
        attachName: null, attachFile: null
    };
    db.assignments.push(asgn);
    writeDB(db);
    // Öğrencilere socket bildirimi
    (cls.students || []).forEach(username => {
        const sids = userSockets.get(username);
        if (sids) sids.forEach(sid => io.to(sid).emit('course-notification', {
            type: 'new-asgn', title: '📋 Yeni Ödev: ' + title,
            body: (due ? 'Son: ' + due : '') + (desc ? ' · ' + desc.slice(0, 50) : ''),
            courseId: cls.id, courseName: cls.name, icon: '📋', unreadType: 'asgn'
        }));
    });
    res.json({ success: true, assignment: asgn });
});

// Ödev dosya eki (öğretmen, raw)
app.patch('/api/courses/:courseId/assignments/:assignId/attachment', requireAuth,
    express.raw({ type: '*/*', limit: '200mb' }),
    (req, res) => {
        const { err, db } = _asgnAuth(req, res, 'teacher');
        if (err) return;
        if (!db.assignments) return res.status(404).json({ error: 'Not found' });
        const idx = db.assignments.findIndex(a => a.id === req.params.assignId && a.courseId === req.params.courseId);
        if (idx === -1) return res.status(404).json({ error: 'Not found' });
        const originalName = decodeURIComponent(req.headers['x-attach-filename'] || 'dosya');
        const ext          = path.extname(originalName).toLowerCase().slice(1);
        const storedName   = `asgn_${req.params.assignId}.${ext || 'bin'}`;
        try {
            fs.writeFileSync(`./public/asgn-attach/${storedName}`, req.body);
            if (db.assignments[idx].attachFile) {
                try { fs.unlinkSync(`./public/asgn-attach/${db.assignments[idx].attachFile}`); } catch(e) {}
            }
            db.assignments[idx].attachName = originalName;
            db.assignments[idx].attachFile = storedName;
            writeDB(db);
            res.json({ success: true, attachName: originalName, attachFile: storedName });
        } catch(e) { res.status(500).json({ error: 'Upload failed' }); }
    }
);

// Ödev sil (öğretmen)
app.delete('/api/courses/:courseId/assignments/:assignId', requireAuth, (req, res) => {
    const { err, db } = _asgnAuth(req, res, 'teacher');
    if (err) return;
    if (!db.assignments) return res.status(404).json({ error: 'Not found' });
    const idx = db.assignments.findIndex(a => a.id === req.params.assignId && a.courseId === req.params.courseId);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const [removed] = db.assignments.splice(idx, 1);
    if (removed.attachFile) { try { fs.unlinkSync(`./public/asgn-attach/${removed.attachFile}`); } catch(e) {} }
    db.submissions = (db.submissions || []).filter(s => s.assignId !== req.params.assignId);
    writeDB(db);
    res.json({ success: true });
});

// Ödev teslimlerini listele (öğretmen)
app.get('/api/courses/:courseId/assignments/:assignId/submissions', requireAuth, (req, res) => {
    const { err, db, isOwner } = _asgnAuth(req, res, 'member');
    if (err) return;
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });
    const subs = (db.submissions || []).filter(s => s.assignId === req.params.assignId);
    res.json(subs);
});

// Kendi teslimim (öğrenci)
app.get('/api/courses/:courseId/assignments/:assignId/submissions/me', requireAuth, (req, res) => {
    const { err, db, isStudent } = _asgnAuth(req, res, 'member');
    if (err) return;
    if (!isStudent) return res.status(403).json({ error: 'Forbidden' });
    const sub = (db.submissions || []).find(s => s.assignId === req.params.assignId && s.username === req.authUser);
    res.json(sub || null);
});

// Teslim oluştur/güncelle (öğrenci, JSON)
app.post('/api/courses/:courseId/assignments/:assignId/submissions', requireAuth, (req, res) => {
    const { err, db, isStudent } = _asgnAuth(req, res, 'member');
    if (err) return;
    if (!isStudent) return res.status(403).json({ error: 'Forbidden' });
    const asgn = (db.assignments || []).find(a => a.id === req.params.assignId && a.courseId === req.params.courseId);
    if (!asgn) return res.status(404).json({ error: 'Assignment not found' });
    if (!db.submissions) db.submissions = [];
    const { text } = req.body;
    const today  = new Date().toISOString().slice(0, 10);
    const isLate = !!(asgn.due && today > asgn.due);
    const existing = db.submissions.findIndex(s => s.assignId === req.params.assignId && s.username === req.authUser);
    const sub = {
        id:          existing >= 0 ? db.submissions[existing].id : ('sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5)),
        assignId:    req.params.assignId,
        courseId:    req.params.courseId,
        username:    req.authUser,
        text:        text || '',
        isLate,
        submittedAt: new Date().toISOString(),
        date:        today,
        fileName:    existing >= 0 ? (db.submissions[existing].fileName || null) : null,
        filePath:    existing >= 0 ? (db.submissions[existing].filePath || null) : null,
    };
    if (existing >= 0) db.submissions[existing] = sub;
    else db.submissions.push(sub);
    writeDB(db);
    res.json({ success: true, submission: sub });
});

// Teslim dosyası yükle (öğrenci, raw)
app.post('/api/courses/:courseId/assignments/:assignId/submissions/file', requireAuth,
    express.raw({ type: '*/*', limit: '50mb' }),
    (req, res) => {
        const { err, db, isStudent } = _asgnAuth(req, res, 'member');
        if (err) return;
        if (!isStudent) return res.status(403).json({ error: 'Forbidden' });
        if (!db.submissions) return res.status(404).json({ error: 'Submit first' });
        const idx = db.submissions.findIndex(s => s.assignId === req.params.assignId && s.username === req.authUser);
        if (idx === -1) return res.status(404).json({ error: 'Submit first' });
        const originalName = decodeURIComponent(req.headers['x-submission-filename'] || 'dosya');
        const ext          = path.extname(originalName).toLowerCase().slice(1);
        const storedName   = `sub_${db.submissions[idx].id}.${ext || 'bin'}`;
        try {
            if (db.submissions[idx].filePath) { try { fs.unlinkSync(`./public/submissions/${db.submissions[idx].filePath}`); } catch(e) {} }
            fs.writeFileSync(`./public/submissions/${storedName}`, req.body);
            db.submissions[idx].fileName = originalName;
            db.submissions[idx].filePath = storedName;
            writeDB(db);
            res.json({ success: true, fileName: originalName, filePath: storedName });
        } catch(e) { res.status(500).json({ error: 'Upload failed' }); }
    }
);

// Teslim değerlendir (öğretmen)
app.patch('/api/courses/:courseId/assignments/:assignId/submissions/:subId/grade', requireAuth, (req, res) => {
    const { err, db, cls } = _asgnAuth(req, res, 'teacher');
    if (err) return;
    if (!db.submissions) return res.status(404).json({ error: 'Not found' });
    const idx = db.submissions.findIndex(s => s.id === req.params.subId && s.assignId === req.params.assignId && s.courseId === req.params.courseId);
    if (idx === -1) return res.status(404).json({ error: 'Submission not found' });
    const asgn  = (db.assignments || []).find(a => a.id === req.params.assignId);
    const { grade, feedback } = req.body;
    if (grade === undefined || grade === null || grade === '') return res.status(400).json({ error: 'Grade required' });
    const gradeNum = Number(grade);
    if (isNaN(gradeNum) || gradeNum < 0) return res.status(400).json({ error: 'Invalid grade' });
    const maxGrade = asgn?.maxGrade || 100;
    if (gradeNum > maxGrade) return res.status(400).json({ error: `Grade cannot exceed ${maxGrade}` });
    db.submissions[idx].grade    = gradeNum;
    db.submissions[idx].feedback = feedback || '';
    db.submissions[idx].gradedAt = new Date().toISOString();
    db.submissions[idx].gradedBy = req.authUser;
    db.submissions[idx].graded   = true;
    writeDB(db);
    const studentUsername = db.submissions[idx].username;
    const sids = userSockets.get(studentUsername);
    if (sids) sids.forEach(sid => io.to(sid).emit('course-notification', {
        type: 'asgn-graded', title: '📊 Ödeviniz Değerlendirildi',
        body: `${asgn?.title || 'Ödeviniz'} için ${gradeNum}/${maxGrade} puan aldınız.`,
        courseId: req.params.courseId, courseName: cls.name, icon: '📊', unreadType: 'asgn'
    }));
    res.json({ success: true, submission: db.submissions[idx] });
});

// ── QUIZ YÖNETİMİ ────────────────────────────────────────────────────────────

function _quizAuth(req, res, role) {
    const db = readDB();
    const user = db.users.find(u => u.username === req.authUser);
    if (!user) return { err: res.status(401).json({ error: 'Unauthorized' }) };
    const cls = (db.classes || []).find(c => c.id === req.params.courseId);
    if (!cls) return { err: res.status(404).json({ error: 'Course not found' }) };
    const isOwner   = cls.teacher === req.authUser;
    const isStudent = user.role === 'student' && (cls.students || []).includes(req.authUser);
    if (role === 'teacher' && !isOwner) return { err: res.status(403).json({ error: 'Forbidden' }) };
    if (role === 'member'  && !isOwner && !isStudent) return { err: res.status(403).json({ error: 'Forbidden' }) };
    return { db, user, cls, isOwner, isStudent };
}

// Quiz listesi
app.get('/api/courses/:courseId/quizzes', requireAuth, (req, res) => {
    const { err, db, isOwner } = _quizAuth(req, res, 'member');
    if (err) return;
    const quizzes = (db.quizzes || []).filter(q => q.courseId === req.params.courseId);
    res.json(isOwner ? quizzes : quizzes.filter(q => q.status === 'published'));
});

// Quiz oluştur / güncelle (öğretmen)
app.post('/api/courses/:courseId/quizzes', requireAuth, (req, res) => {
    const { err, db } = _quizAuth(req, res, 'teacher');
    if (err) return;
    if (!db.quizzes) db.quizzes = [];
    const { id, title, desc, questions, status } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const existing = id ? db.quizzes.findIndex(q => q.id === id && q.courseId === req.params.courseId) : -1;
    const quiz = {
        id:        id || ('qz_' + Date.now() + '_' + Math.random().toString(36).slice(2,5)),
        courseId:  req.params.courseId,
        teacher:   req.authUser,
        title, desc: desc || '',
        questions: questions || [],
        status:    status || 'draft',
        createdAt: existing >= 0 ? db.quizzes[existing].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    if (existing >= 0) db.quizzes[existing] = quiz;
    else db.quizzes.unshift(quiz);
    writeDB(db);
    res.json({ success: true, quiz });
});

// Quiz sil (öğretmen)
app.delete('/api/courses/:courseId/quizzes/:quizId', requireAuth, (req, res) => {
    const { err, db } = _quizAuth(req, res, 'teacher');
    if (err) return;
    if (!db.quizzes) return res.status(404).json({ error: 'Not found' });
    const idx = db.quizzes.findIndex(q => q.id === req.params.quizId && q.courseId === req.params.courseId);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.quizzes.splice(idx, 1);
    if (db.quizResponses) db.quizResponses = db.quizResponses.filter(r => r.quizId !== req.params.quizId);
    writeDB(db);
    res.json({ success: true });
});

// Quiz yanıtları — tümü (öğretmen)
app.get('/api/courses/:courseId/quizzes/:quizId/responses', requireAuth, (req, res) => {
    const { err, db } = _quizAuth(req, res, 'teacher');
    if (err) return;
    res.json((db.quizResponses || []).filter(r => r.quizId === req.params.quizId));
});

// Kendi yanıtım (öğrenci)
app.get('/api/courses/:courseId/quizzes/:quizId/responses/me', requireAuth, (req, res) => {
    const { err, db } = _quizAuth(req, res, 'member');
    if (err) return;
    const resp = (db.quizResponses || []).find(r => r.quizId === req.params.quizId && r.username === req.authUser);
    res.json(resp || null);
});

// Yanıt gönder (öğrenci)
app.post('/api/courses/:courseId/quizzes/:quizId/responses', requireAuth, (req, res) => {
    const { err, db, isOwner } = _quizAuth(req, res, 'member');
    if (err) return;
    if (isOwner) return res.status(403).json({ error: 'Teachers cannot submit responses' });
    if (!db.quizResponses) db.quizResponses = [];
    const already = db.quizResponses.find(r => r.quizId === req.params.quizId && r.username === req.authUser);
    if (already) return res.status(409).json({ error: 'Already submitted' });
    const quiz = (db.quizzes || []).find(q => q.id === req.params.quizId && q.courseId === req.params.courseId);
    if (!quiz || quiz.status !== 'published') return res.status(404).json({ error: 'Quiz not found or not published' });
    const resp = {
        id:          'qr_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
        quizId:      req.params.quizId,
        courseId:    req.params.courseId,
        username:    req.authUser,
        answers:     req.body.answers || {},
        submittedAt: new Date().toISOString()
    };
    db.quizResponses.push(resp);
    writeDB(db);
    res.json({ success: true, response: resp });
});

// Açık uçlu cevapları puanla (öğretmen)
app.patch('/api/courses/:courseId/quizzes/:quizId/responses/:responseId', requireAuth, (req, res) => {
    const { err, db } = _quizAuth(req, res, 'teacher');
    if (err) return;
    if (!db.quizResponses) return res.status(404).json({ error: 'Not found' });
    const idx = db.quizResponses.findIndex(r => r.id === req.params.responseId && r.quizId === req.params.quizId);
    if (idx === -1) return res.status(404).json({ error: 'Response not found' });
    db.quizResponses[idx].grades   = req.body.grades || {};
    db.quizResponses[idx].gradedAt = new Date().toISOString();
    db.quizResponses[idx].gradedBy = req.authUser;
    writeDB(db);
    res.json({ success: true, response: db.quizResponses[idx] });
});

// SPA — /app rotası app.html'e yönlendirir
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════════════════════════════════════

const roomTeacher = new Map(); // roomId → teacherSocketId
const roomChat    = new Map(); // roomId → [{sender, role, text, time}]

io.on('connection', (socket) => {

    // KİMLİK DOĞRULAMA — socket'i kullanıcıya bağla
    socket.on('authenticate', (token) => {
        const username = sessions.get(token);
        if (username) {
            socket.authUser = username;
            if (!userSockets.has(username)) userSockets.set(username, new Set());
            userSockets.get(username).add(socket.id);
        }
    });

    // DERS OLUŞTUR
    socket.on('create-lesson', (data) => {
        const roomId    = Math.random().toString(36).substring(2, 8);
        const sessionId = data.sessionId || ('ls_' + Date.now());
        socket.join(roomId);
        socket.roomId      = roomId;
        socket.sessionId   = sessionId;
        socket.courseId    = data.courseId || null;
        socket.isTeacher   = true;
        roomTeacher.set(roomId, socket.id);
        roomChat.set(roomId, []);
        roomStartTime.set(roomId, Date.now());
        // Canlı oturumu DB'ye kaydet
        if (data.courseId) {
            const db = readDB();
            if (!db.live_sessions) db.live_sessions = [];
            // Aynı courseId için önceki aktif oturumu kapat
            db.live_sessions.forEach(s => {
                if (s.courseId === data.courseId && s.status === 'active') {
                    s.status = 'ended'; s.endedAt = new Date().toISOString();
                }
            });
            const session = {
                id: sessionId,
                courseId:        data.courseId,
                title:           data.sessionTitle || data.name,
                roomId,
                teacherUsername: socket.authUser || '',
                status:          'active',
                createdAt:       new Date().toISOString(),
                endedAt:         null,
                lessonReportId:  null
            };
            db.live_sessions.push(session);
            writeDB(db);
            activeSessions.set(sessionId, { roomId, courseId: data.courseId, title: session.title, teacherUsername: session.teacherUsername });
            // Kayıtlı öğrencilere bildir
            const cls = (db.classes || []).find(c => c.id === data.courseId);
            if (cls) {
                (cls.students || []).forEach(username => {
                    const sids = userSockets.get(username);
                    if (sids) sids.forEach(sid => io.to(sid).emit('live-session-started', { session: { ...session, courseName: cls.name, courseColor: cls.color, courseIcon: cls.icon } }));
                });
            }
        }
        socket.emit('lesson-created', roomId);
        console.log(`[DERS] "${data.name}" → Oda: ${roomId}, Session: ${sessionId}`);
    });

    // ODAYA KATIL
    socket.on('join-room', (roomId, userName, userUsername) => {
        const r = (roomId || '').toLowerCase().trim();
        // Yetki: canlı oturum varsa ve courseId bağlıysa öğrenci kaydı kontrol et
        const db = readDB();
        const sessionForRoom = (db.live_sessions || []).find(s => s.roomId === r && s.status === 'active');
        if (sessionForRoom && userUsername) {
            const user = db.users.find(u => u.username === userUsername);
            if (user && user.role === 'student') {
                const cls = (db.classes || []).find(c => c.id === sessionForRoom.courseId);
                if (cls && !(cls.students || []).includes(userUsername)) {
                    socket.emit('join-error', { message: 'Bu derse kayıtlı değilsiniz.' });
                    return;
                }
            }
        }
        socket.join(r);
        socket.userName     = userName;
        socket.userUsername = userUsername || userName;
        socket.roomId       = r;
        const startTs   = roomStartTime.get(r) || Date.now();
        const joinDelay = Math.floor((Date.now() - startTs) / 1000); // ders başından saniye cinsinden gecikme
        socket.joinDelay = joinDelay;
        console.log(`[+] ${userName} (${userUsername}) → Oda: ${r}, gecikme: ${joinDelay}s`);
        if (sessionForRoom) socket.emit('lesson-info', { title: sessionForRoom.title || '' });

        const teacherId = roomTeacher.get(r);
        if (teacherId && teacherId !== socket.id) {
            const teacherSocket = io.sockets.sockets.get(teacherId);
            socket.emit('teacher-socket-id', { id: teacherId, name: teacherSocket?.userName || '' });
            io.to(teacherId).emit('new-student', { studentId: socket.id, name: userName, username: socket.userUsername, joinDelay });
            socket.to(r).emit('participant-joined', { id: socket.id, name: userName, username: socket.userUsername });
            const roomSockets = io.sockets.adapter.rooms.get(r);
            if (roomSockets) {
                const participants = [];
                for (const sid of roomSockets) {
                    const s = io.sockets.sockets.get(sid);
                    if (s && s.userName && !s.isTeacher && sid !== socket.id) {
                        participants.push({ id: sid, name: s.userName });
                    }
                }
                if (participants.length) socket.emit('room-participants', participants);
            }
            const history = roomChat.get(r);
            if (history && history.length) socket.emit('chat-history', history);
        }
    });

    // Öğretmen canlı sekmesini odanın sahibi olarak kaydet (ana sekme yerine yeni sekme)
    socket.on('claim-teacher-room', (roomId) => {
        const r = (roomId || '').toLowerCase().trim();
        if (!r) return;
        socket.join(r);
        socket.roomId    = r;
        socket.isTeacher = true;
        roomTeacher.set(r, socket.id);
        // Odadaki mevcut öğrencileri yeni öğretmen sekmesine gönder
        const roomSockets = io.sockets.adapter.rooms.get(r);
        if (roomSockets) {
            const participants = [];
            for (const sid of roomSockets) {
                const s = io.sockets.sockets.get(sid);
                if (s && s.userName && !s.isTeacher && sid !== socket.id) {
                    participants.push({ id: sid, name: s.userName, username: s.userUsername || s.userName, joinDelay: s.joinDelay || 0 });
                }
            }
            if (participants.length) socket.emit('room-participants', participants);
        }
        console.log(`[DERS] Öğretmen sekmesi odayı devraldı → Oda: ${r}`);
    });

    // WebRTC sinyalleri
    socket.on('webrtc-offer',  ({ targetId, sdp })       => io.to(targetId).emit('webrtc-offer',  { fromId: socket.id, sdp }));
    socket.on('webrtc-answer', ({ targetId, sdp })       => io.to(targetId).emit('webrtc-answer', { fromId: socket.id, sdp }));
    socket.on('webrtc-ice',    ({ targetId, candidate }) => io.to(targetId).emit('webrtc-ice',    { fromId: socket.id, candidate }));

    // Ekran paylaşımı bildirimleri
    socket.on('screen-share-started', () => socket.to(socket.roomId).emit('screen-share-started', { teacherId: socket.id }));
    socket.on('screen-share-stopped', () => socket.to(socket.roomId).emit('screen-share-stopped'));

    // Sınıf sohbeti
    socket.on('chat-message', ({ room, sender, role, text }) => {
        const r = (room || socket.roomId || '').toLowerCase().trim();
        const now = new Date();
        const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
        const msg = { sender, role, text, time };
        if (!roomChat.has(r)) roomChat.set(r, []);
        const history = roomChat.get(r);
        history.push(msg);
        if (history.length > 100) history.shift();
        socket.to(r).emit('chat-message', msg);
    });

    // Öğrenci analiz verisi
    socket.on('student-data', (data) => {
        socket.to(socket.roomId).emit('update-teacher-dashboard', {
            id: socket.id, name: socket.userName, username: socket.userUsername, ...data
        });
    });

    // Öğrenci odadan ayrıldı
    socket.on('leave-room', () => {
        const teacherId = roomTeacher.get(socket.roomId);
        if (teacherId) io.to(teacherId).emit('student-left', { studentId: socket.id });
        socket.to(socket.roomId).emit('participant-left', { id: socket.id });
        if (socket.userName) console.log(`[-] ${socket.userName} odadan ayrıldı → Oda: ${socket.roomId}`);
        socket.roomId   = null;
        socket.userName = null;
    });

    // El kaldır
    socket.on('hand-raise', ({ raised }) => {
        const teacherId = roomTeacher.get(socket.roomId);
        if (teacherId) io.to(teacherId).emit('student-hand-raise', { studentId: socket.id, studentName: socket.userName, raised });
    });

    // Öğrenci uyarısı
    socket.on('student-alert', (data) => {
        const teacherId = roomTeacher.get(socket.roomId);
        if (teacherId) io.to(teacherId).emit('student-alert', { ...data, studentId: socket.id, studentName: socket.userName });
    });

    // Dersi bitir
    socket.on('finish-lesson', (roomId, sessionId) => {
        io.to(roomId).emit('lesson-closed-by-teacher');
        roomChat.delete(roomId);
        roomStartTime.delete(roomId);
        // Canlı oturumu kapat
        const sid = sessionId || socket.sessionId;
        if (sid) {
            activeSessions.delete(sid);
            const db = readDB();
            const sess = (db.live_sessions || []).find(s => s.id === sid);
            if (sess) { sess.status = 'ended'; sess.endedAt = new Date().toISOString(); writeDB(db); }
        }
    });

    // Raporu kaydet
    socket.on('save-lesson-report', (reportData, callback) => {
        const db = readDB();
        const id = Date.now();
        const lesson = {
            ...reportData,
            id,
            date:            new Date().toLocaleString('tr-TR'),
            timeline:        reportData.timeline    || [],
            focusHistory:    reportData.focusHistory || [],
            duration:        reportData.duration     || 0,
            replayAvailable: false,
            courseId:        reportData.courseId    || null,
            sessionId:       reportData.sessionId   || null
        };
        db.lessons.push(lesson);
        // Canlı oturuma ders raporu ID'sini bağla
        if (reportData.sessionId) {
            const sess = (db.live_sessions || []).find(s => s.id === reportData.sessionId);
            if (sess) { sess.lessonReportId = id; sess.status = 'ended'; sess.endedAt = sess.endedAt || new Date().toISOString(); }
        }
        writeDB(db);
        // Kayıtlı öğrencilere bildir
        if (reportData.courseId) {
            const cls = (db.classes || []).find(c => c.id === reportData.courseId);
            if (cls) {
                (cls.students || []).forEach(username => {
                    const sids = userSockets.get(username);
                    if (sids) sids.forEach(sid2 => io.to(sid2).emit('live-session-ended', { courseId: reportData.courseId, lessonReportId: id }));
                });
            }
        }
        if (typeof callback === 'function') callback(id);
    });

    // Ders içeriği bildirimi (duyuru / ödev / takvim) → kayıtlı öğrencilere ilet
    socket.on('notify-students', ({ targetUsers, notification }) => {
        if (!socket.authUser || !Array.isArray(targetUsers)) return;
        targetUsers.forEach(username => {
            const sids = userSockets.get(username);
            if (sids) sids.forEach(sid => io.to(sid).emit('course-notification', notification));
        });
    });

    // Bağlantı kopunca
    socket.on('disconnect', () => {
        if (socket.authUser) {
            const sids = userSockets.get(socket.authUser);
            if (sids) {
                sids.delete(socket.id);
                if (sids.size === 0) userSockets.delete(socket.authUser);
            }
        }
        if (socket.isTeacher && socket.roomId) {
            roomTeacher.delete(socket.roomId);
            roomChat.delete(socket.roomId);
            // Kopma nedeniyle session'ı kapat
            if (socket.sessionId) {
                activeSessions.delete(socket.sessionId);
                const db = readDB();
                const sess = (db.live_sessions || []).find(s => s.id === socket.sessionId);
                if (sess && sess.status === 'active') { sess.status = 'ended'; sess.endedAt = new Date().toISOString(); writeDB(db); }
            }
            console.log(`[-] Öğretmen ayrıldı → Oda: ${socket.roomId}`);
        } else if (socket.roomId) {
            const teacherId = roomTeacher.get(socket.roomId);
            if (teacherId) io.to(teacherId).emit('student-left', { studentId: socket.id });
            socket.to(socket.roomId).emit('participant-left', { id: socket.id });
            if (socket.userName) console.log(`[-] ${socket.userName} ayrıldı → Oda: ${socket.roomId}`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n  EduSense Pro  →  http://localhost:${PORT}/login.html\n`);
});
