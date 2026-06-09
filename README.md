# EduSense Pro

**TR** | Yapay zeka destekli, gerçek zamanlı öğrenci dikkat takip sistemi. Öğretmenler canlı ders sırasında öğrencilerin odak düzeyini anlık olarak izleyebilir.

**EN** | An AI-powered real-time student attention tracking system. Teachers can monitor students' focus levels live during class sessions.

---

## Canlı Demo / Live Demo

🔗 **https://edusense-pro-fxbu.onrender.com**

> İlk açılışta 30–60 saniye bekleme olabilir (ücretsiz sunucu uyku modundan uyanır).
> The server may take 30–60 seconds to wake up on first visit (free tier).

### Test Hesapları / Test Accounts

| Rol / Role | Kullanıcı Adı / Username | Şifre / Password |
|---|---|---|
| Öğretmen / Teacher | `ercan.akpinar` | `123456` |
| Öğrenci 1 / Student 1 | `ertan.kadim` | `123456` |
| Öğrenci 2 / Student 2 | `umid.yuldashbayev` | `123456` |

---

## Özellikler / Features

**TR**
- Gerçek zamanlı yüz tanıma ile odak skoru hesaplama
- Öğretmen panelinden anlık sınıf izleme
- Dikkat düşüşünde otomatik uyarı sistemi
- Ders sonu detaylı rapor ve grafik
- Ödev oluşturma ve teslim sistemi
- Duyuru yönetimi
- Ders kaydı (replay) özelliği

**EN**
- Real-time focus score calculation via face detection
- Live classroom monitoring from teacher dashboard
- Automatic alerts on attention drops
- Detailed post-lesson reports and charts
- Assignment creation and submission system
- Announcement management
- Lesson recording and replay feature

---

## Teknolojiler / Tech Stack

| | |
|---|---|
| Backend | Node.js, Express.js |
| Gerçek Zamanlı / Real-time | Socket.IO |
| Yüz Tanıma / Face Detection | face-api.js |
| Veri / Data | JSON (file-based) |
| Deployment | Render |

---

## Yerel Kurulum / Local Setup

```bash
# Repoyu klonla / Clone the repo
git clone https://github.com/ertanKadim/edusense-pro.git
cd edusense-pro

# Bağımlılıkları yükle / Install dependencies
npm install

# Sunucuyu başlat / Start the server
npm start
```

Tarayıcıda aç / Open in browser: `http://localhost:3000/login.html`

---

## Proje Yapısı / Project Structure

```
edusense-pro/
├── server.js          # Ana sunucu / Main server
├── database.json      # Kullanıcı ve ders verileri / User & lesson data
├── public/
│   ├── login.html     # Giriş sayfası / Login page
│   ├── app.html       # Ana uygulama / Main app
│   └── models/        # Yüz tanıma modelleri / Face detection models
```

---

© 2026 EduSense Pro
