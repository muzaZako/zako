# Zako — BEPUL ishga tushirish ($0/oy)

Bu qo'llanma Zako'ni **pulsiz** internetda jonli ishga tushirishni qadam-baqadam ko'rsatadi.
Uch bepul xizmat ishlatamiz: **Groq** (AI), **GitHub** (kod), **Render** (hosting). Karta shart emas.

> Natija: `https://zako.onrender.com` kabi manzilda ishlaydigan sayt — $0/oy.

---

## Kerakli fayllar (GitHub'ga shular yuklanadi)
- `Zako.html` — sayt
- `server.js` — backend (AI kalitini yashiradi)
- `package.json` — paketlar ro'yxati
- `.env.example` — sozlama namunasi (eslatma uchun; `.env` ni yuklamang!)

---

## 1-qadam — Groq'dan BEPUL AI kaliti
1. https://console.groq.com saytiga kiring (Google bilan ro'yxatdan o'ting — karta shart emas).
2. Chap menyuda **API Keys** → **Create API Key** → nomini yozing → yarating.
3. Chiqgan kalitni (`gsk_...` bilan boshlanadi) **nusxalab** saqlab qo'ying. (U faqat bir marta to'liq ko'rinadi.)

> Eslatma: Groq bepul rejasi ~30 so'rov/daqiqa beradi — boshlash uchun yetarli.
> Modellar ro'yxati: https://console.groq.com/docs/models (agar `llama-3.3-70b-versatile` ishlamasa, ro'yxatdan amaldagi model nomini oling).

---

## 2-qadam — Kodni GitHub'ga yuklash
1. https://github.com → ro'yxatdan o'ting (bepul).
2. **New repository** → nomi `zako` → **Private** yoki Public → **Create**.
3. "uploading an existing file" havolasi orqali **Zako.html, server.js, package.json, .env.example** fayllarini sudrab tashlang → **Commit**.

> MUHIM: `.env` faylini (kalitlar bilan) **hech qachon** yuklamang. Faqat `.env.example` namunasini yuklang.

---

## 3-qadam — Render'da BEPUL deploy
1. https://render.com → **Get Started** → GitHub bilan kiring (bepul).
2. **New +** → **Web Service** → `zako` repozitoriyangizni tanlang (**Connect**).
3. Sozlamalar:
   - **Name**: `zako` (manzil shu bo'ladi: `zako.onrender.com`)
   - **Region**: eng yaqinini tanlang
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**

---

## 4-qadam — Muhit o'zgaruvchilari (Environment)
Render'da xizmat sahifasida **Environment** bo'limiga o'ting va quyidagilarni qo'shing:

| Key | Value |
|---|---|
| `AI_API_KEY` | Groq kalitingiz (`gsk_...`) |
| `JWT_SECRET` | uzun tasodifiy maxfiy satr (o'zingiz o'ylab toping) |
| `AI_MODEL` | `llama-3.3-70b-versatile` |
| `AUTH_MODE` | `simple` |

Saqlang → Render avtomatik qayta deploy qiladi.

---

## 5-qadam — Tekshirish
1. Deploy tugagach yuqoridagi `https://zako.onrender.com` manzilini oching.
2. Birorta soha (masalan Abituriyent yoki Yurist)da savol bering — AI javob bersa, **tayyor!** 🎉
3. `https://...onrender.com/api/health` ochsangiz `{"ok":true,...}` ko'rinadi.

---

## Halol eslatmalar (bepul rejaning cheklovlari)
- **Uyqu rejimi:** bepul xizmat 15 daqiqa harakatsizlikdan keyin uxlaydi — birinchi ochilish ~30–60 soniya sekin bo'ladi (keyin tez). Uxlamasligi uchun keyinchalik Render **Starter ($7/oy)** ga o'tasiz.
- **AI tezligi/limiti:** Groq bepul rejasida daqiqasiga so'rov soni cheklangan. Ko'p odam bir vaqtda ishlatsa, ba'zan kutish bo'lishi mumkin.
- **AI sifati:** bepul rejada Groq (Llama) modeli ishlaydi — bu Claude emas, javob sifati biroz farq qilishi mumkin. Budjet bo'lganda Claude'ga o'tish uchun: `AI_PROVIDER=anthropic`, `AI_API_KEY=sk-ant-...`, `AI_MODEL=claude-3-5-haiku-latest`.
- **Hisoblar (login):** bepul rejada doimiy disk yo'q, shuning uchun ro'yxatdan o'tgan hisoblar server qayta ishga tushganda **o'chishi mumkin**. Lekin: saytdan **login qilmasdan ham** to'liq foydalanish mumkin (testlar, kalkulyatorlar, AI), va foydalanuvchi progressi uning **brauzerida** (localStorage) saqlanadi. Doimiy hisob kerak bo'lsa — bepul **Neon** yoki **Supabase** (PostgreSQL) ulaymiz (yordam bera olaman).

---

## Keyingi (ixtiyoriy) yaxshilashlar
1. **O'z domeningiz** (masalan `zako.uz`) — Render → Settings → Custom Domain (domen ~$10–20/yil).
2. **Doimiy baza** — Neon/Supabase bepul PostgreSQL (hisoblar yo'qolmaydi).
3. **Uxlamaslik + tezlik** — Render Starter ($7/oy).
4. **Claude sifati** — budjet bo'lganda `AI_PROVIDER=anthropic`.
5. **SMS tasdiq** — kerak bo'lsa `AUTH_MODE=otp` + Eskiz.uz (har SMS pullik).

---

Savol bo'lsa — qaysi qadamda qiynalsangiz, ayting, birga hal qilamiz.
