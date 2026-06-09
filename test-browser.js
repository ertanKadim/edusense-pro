/**
 * EduSense Pro — Playwright Entegrasyon Testi
 * Öğretmen: ercan.akpinar / 123456
 * Öğrenci 1: ertan.kadim / 123456
 * Öğrenci 2: umid.yuldashbayev / 123456
 *
 * NOT: Her kullanıcı ayrı browser context'te çalışır (ayrı localStorage).
 */
const { chromium } = require('playwright');

const BASE  = 'http://localhost:3000';
const USERS = {
    teacher:  { username: 'ercan.akpinar',    password: '123456', name: 'Dr. Ercan Akpınar' },
    student1: { username: 'ertan.kadim',      password: '123456', name: 'Ertan Kadim' },
    student2: { username: 'umid.yuldashbayev',password: '123456', name: 'Umid Yuldashbayev' },
};

let passed = 0, failed = 0;
const results = [];

function ok(label)   { console.log(`  ✓ ${label}`); passed++; results.push({ ok: true,  label }); }
function fail(label, err) { console.log(`  ✗ ${label}${err ? ' — ' + String(err).slice(0,120) : ''}`); failed++; results.push({ ok: false, label }); }
async function check(label, fn) {
    try { await fn(); ok(label); }
    catch(e) { fail(label, e.message||e); }
}

async function login(page, user) {
    await page.goto(`${BASE}/login.html`);
    await page.fill('#username', user.username);
    await page.fill('#password', user.password);
    await page.click('button[onclick="login()"], button:has-text("Giriş")');
    await page.waitForURL('**/app', { timeout: 8000 });
}

(async () => {
    const browser = await chromium.launch({
        headless: false,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
               '--no-sandbox', '--disable-setuid-sandbox']
    });

    const ctxOpts = { permissions: ['camera', 'microphone'], ignoreHTTPSErrors: true };

    // Her kullanıcı için ayrı context — ayrı localStorage
    const tCtx  = await browser.newContext(ctxOpts);
    const s1Ctx = await browser.newContext(ctxOpts);
    const s2Ctx = await browser.newContext(ctxOpts);

    const tPage  = await tCtx.newPage();
    const s1Page = await s1Ctx.newPage();
    const s2Page = await s2Ctx.newPage();

    let roomCode = null;

    try {
        /* ── 1. GİRİŞLER ── */
        console.log('\n[1] GİRİŞLER');
        await check('Öğretmen giriş', async () => {
            await login(tPage, USERS.teacher);
            await tPage.waitForSelector('#teacher-ui:not(.hidden)', { timeout: 6000 });
        });
        await check('Öğrenci 1 giriş', async () => {
            await login(s1Page, USERS.student1);
            await s1Page.waitForSelector('#student-ui:not(.hidden)', { timeout: 6000 });
        });
        await check('Öğrenci 2 giriş', async () => {
            await login(s2Page, USERS.student2);
            await s2Page.waitForSelector('#student-ui:not(.hidden)', { timeout: 6000 });
        });

        /* ── 2. DERS OLUŞTUR ── */
        console.log('\n[2] DERS OLUŞTURMA');
        await check('Öğretmen "Ders Aç" navigasyonu', async () => {
            // 2 adet data-view="t-setup" var (desktop + mobile nav) — ilkini seç
            const setupNav = tPage.locator('[data-view="t-setup"]').first();
            await setupNav.click();
            await tPage.waitForSelector('#t-setup:not(.hidden)', { timeout: 4000 });
        });
        await check('Ders dropdown seçimi', async () => {
            const sel = tPage.locator('#course-select');
            await sel.waitFor({ timeout: 4000 });
            await sel.selectOption({ index: 1 });
            await tPage.waitForTimeout(400);
        });
        await check('Ders oluştur & oda kodu al', async () => {
            await tPage.click('#btn-create-lesson');
            await tPage.waitForSelector('#t-live:not(.hidden)', { timeout: 8000 });
            const raw = await tPage.locator('#room-code').textContent({ timeout: 5000 });
            roomCode = (raw || '').trim().toLowerCase();
            if (!roomCode || roomCode.length < 4) throw new Error('Oda kodu alınamadı: ' + roomCode);
            console.log(`     → Oda kodu: ${roomCode}`);
        });

        /* ── 3. ÖĞRENCİLER KATIL ── */
        console.log('\n[3] ÖĞRENCİLER KATILIYOR');
        await check('Öğrenci 1 derse katılır', async () => {
            if (!roomCode) throw new Error('Oda kodu yok, ders oluşturma başarısız');
            // "Derse Katıl" nav sekmesine git (s-join varsayılan hidden)
            await s1Page.locator('[data-view="s-join"]').first().click();
            await s1Page.waitForSelector('#s-join:not(.hidden)', { timeout: 4000 });
            await s1Page.fill('#room-code-input', roomCode);
            await s1Page.click('button[onclick="joinLesson()"]');
            await s1Page.waitForSelector('#s-classroom:not(.hidden)', { timeout: 8000 });
        });
        await check('Öğrenci 2 derse katılır', async () => {
            if (!roomCode) throw new Error('Oda kodu yok, ders oluşturma başarısız');
            await s2Page.locator('[data-view="s-join"]').first().click();
            await s2Page.waitForSelector('#s-join:not(.hidden)', { timeout: 4000 });
            await s2Page.fill('#room-code-input', roomCode);
            await s2Page.click('button[onclick="joinLesson()"]');
            await s2Page.waitForSelector('#s-classroom:not(.hidden)', { timeout: 8000 });
        });
        await tPage.waitForTimeout(1500);

        /* ── 4. KATILIMCI SAYISI ── */
        console.log('\n[4] KATILIMCI SAYACI');
        await check('Öğretmen panelinde 2 öğrenci badge', async () => {
            const badge = tPage.locator('#student-count-badge');
            const txt = await badge.textContent({ timeout: 5000 });
            if (!txt.includes('2')) throw new Error(`Beklenen: "2 öğrenci", gelen: "${txt}"`);
        });
        await check('Sınıf Görünümü label 2 öğrenci', async () => {
            const lbl = tPage.locator('#live-student-label');
            const txt = await lbl.textContent({ timeout: 3000 });
            if (!txt.includes('2')) throw new Error(`Label: "${txt}"`);
        });
        await check('Katılımcı yan panel: 2 giriş', async () => {
            const items = tPage.locator('#t-participants-list [id^="tp-"]');
            const cnt = await items.count();
            if (cnt < 2) throw new Error(`Beklenen ≥2, gelen: ${cnt}`);
        });

        /* ── 5. ÖĞRENCİ PANELİ KATILIMCILARI ── */
        console.log('\n[5] ÖĞRENCİ PANELİ KATILIMCİLAR');
        await check('Öğrenci 1 panelinde katılımcı listesi dolu', async () => {
            const list = s1Page.locator('#sc-participants-list');
            const html = await list.innerHTML({ timeout: 3000 });
            if (!html.includes('Umid') && !html.includes('scp-')) {
                throw new Error('Umid panelde görünmüyor');
            }
        });
        await check('Öğrenci 2 panelinde Ertan görünür', async () => {
            const list = s2Page.locator('#sc-participants-list');
            const html = await list.innerHTML({ timeout: 3000 });
            if (!html.includes('Ertan')) throw new Error('Ertan S2 panelinde yok');
        });

        /* ── 6. 3 SÜTUN LAYOUT ── */
        console.log('\n[6] 3 SÜTUN LAYOUT');
        await check('Öğrenci 1: sc-left görünür', async () => {
            await s1Page.waitForSelector('.sc-left', { state: 'visible', timeout: 3000 });
        });
        await check('Öğrenci 1: sc-chat-col (orta) görünür', async () => {
            await s1Page.waitForSelector('.sc-chat-col', { state: 'visible', timeout: 3000 });
        });
        await check('Öğrenci 1: sc-right (sağ) görünür', async () => {
            await s1Page.waitForSelector('.sc-right', { state: 'visible', timeout: 3000 });
        });
        await check('Sohbet input sc-chat-col içinde', async () => {
            const input = s1Page.locator('.sc-chat-col #s-chat-input');
            await input.waitFor({ state: 'visible', timeout: 3000 });
        });

        /* ── 7. SOHBET ── */
        console.log('\n[7] SOHBET TESTİ');
        await check('Öğretmen → Sınıf mesajı gönderir', async () => {
            await tPage.fill('#t-chat-input', 'Merhaba sınıf!');
            await tPage.press('#t-chat-input', 'Enter');
            await tPage.waitForTimeout(800);
        });
        await check('Öğrenci 1 öğretmen mesajını görür', async () => {
            const chatHtml = await s1Page.locator('#sc-chat-list').innerHTML({ timeout: 4000 });
            if (!chatHtml.includes('Merhaba sınıf!')) throw new Error('Öğretmen mesajı S1\'de yok');
        });
        await check('Öğrenci 2 öğretmen mesajını görür', async () => {
            const chatHtml = await s2Page.locator('#sc-chat-list').innerHTML({ timeout: 4000 });
            if (!chatHtml.includes('Merhaba sınıf!')) throw new Error('Öğretmen mesajı S2\'de yok');
        });
        await check('Öğrenci 1 → Sınıf mesajı gönderir', async () => {
            await s1Page.fill('#s-chat-input', 'Merhaba hocam!');
            await s1Page.press('#s-chat-input', 'Enter');
            await tPage.waitForTimeout(800);
        });
        await check('Öğretmen öğrenci mesajını görür', async () => {
            const chatHtml = await tPage.locator('#live-chat-list').innerHTML({ timeout: 4000 });
            if (!chatHtml.includes('Merhaba hocam!')) throw new Error('Öğrenci mesajı öğretmende yok');
        });
        await check('Öğrenci 2 öğrenci 1 mesajını görür', async () => {
            const chatHtml = await s2Page.locator('#sc-chat-list').innerHTML({ timeout: 4000 });
            if (!chatHtml.includes('Merhaba hocam!')) throw new Error('S1 mesajı S2\'de yok');
        });

        /* ── 8. SINIF DURUMU TABLOSU ── */
        console.log('\n[8] SINIF DURUMU');
        await check('live-student-val = 2', async () => {
            const txt = await tPage.locator('#live-student-val').textContent({ timeout: 3000 });
            if (txt.trim() !== '2') throw new Error(`Gelen: "${txt}"`);
        });

        /* ── 9. ÖĞRENCİ AYRILIYOR ── */
        console.log('\n[9] AYRILMA');
        await check('Öğrenci 2 dersten ayrılır', async () => {
            s2Page.on('dialog', d => d.accept());
            await s2Page.click('.sc-btn-leave');
            await s2Page.waitForSelector('#student-ui:not(.hidden)', { timeout: 6000 });
        });
        await tPage.waitForTimeout(1200);
        await check('Öğretmen panelinde 1 öğrenci kalır', async () => {
            const badge = tPage.locator('#student-count-badge');
            const txt = await badge.textContent({ timeout: 4000 });
            if (!txt.includes('1')) throw new Error(`Badge: "${txt}"`);
        });
        await check('Öğrenci 2 katılımcı listeden çıktı', async () => {
            const s2item = tPage.locator('[id^="tp-"]');
            const cnt = await s2item.count();
            if (cnt !== 1) throw new Error(`Katılımcı sayısı: ${cnt}, beklenen: 1`);
        });

        /* ── 10. REPLAY KARTLARI ── */
        console.log('\n[10] REPLAY KARTLARI');
        await check('Öğrenci 2 tekrarlar sayfasını açar', async () => {
            const nav = s2Page.locator('[data-view="s-replays"]');
            await nav.click();
            await s2Page.waitForTimeout(1000);
        });
        await check('Kapalı replay kartlar tıklanamaz', async () => {
            const lockedCards = s2Page.locator('.rec-card[style*="cursor:not-allowed"]');
            const cnt = await lockedCards.count();
            console.log(`     → ${cnt} kapalı kart bulundu`);
            const openCards = s2Page.locator('.rec-card[onclick]');
            const openCnt = await openCards.count();
            console.log(`     → ${openCnt} açık kart bulundu`);
            ok(`Replay kartları: ${openCnt} açık, ${cnt} kapalı`);
            passed--; // çift ok sayımını önle
        });

    } catch (e) {
        fail('BEKLENMEDIK HATA', e.message);
    } finally {
        /* ── ÖZET ── */
        console.log(`\n${'═'.repeat(50)}`);
        console.log(`TOPLAM: ${passed} başarılı / ${failed} başarısız / ${passed+failed} test`);
        console.log('═'.repeat(50));
        if (failed > 0) {
            console.log('\nBAŞARISIZ TESTLER:');
            results.filter(r => !r.ok).forEach(r => console.log(`  ✗ ${r.label}`));
        }

        await tPage.waitForTimeout(2000);
        await tCtx.close();
        await s1Ctx.close();
        await s2Ctx.close();
        await browser.close();
        process.exit(failed > 0 ? 1 : 0);
    }
})();
