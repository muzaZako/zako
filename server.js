/* ============================================================
   ZAKO — backend server (asl/bepul versiya)
   - AI proxy: kalit FAQAT serverda qoladi (xavfsiz)
       • Bepul: Groq / Gemini (OpenAI-mos) — AI_PROVIDER=openai
       • Pullik: Anthropic (Claude)       — AI_PROVIDER=anthropic
   - Ro'yxatdan o'tish:
       • AUTH_MODE=simple (standart) — SMSsiz, telefon+parol (BEPUL)
       • AUTH_MODE=otp               — SMS kod (Eskiz.uz, pullik)
   - Parol hash (bcrypt) + JWT token
   - 50-foydalanuvchi hisoblagichi (/api/stats)
   - Frontendni (Zako.html) ko'rsatadi
   Ishga tushirish:  npm install  &&  npm start
   ============================================================ */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (e) {}

const app = express();
app.use(express.json({ limit: '8mb' }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ALMASHTIRING-uzun-maxfiy-kalit';
const PAID_THRESHOLD = parseInt(process.env.PAID_THRESHOLD || '50', 10);
const AUTH_MODE = (process.env.AUTH_MODE || 'simple').toLowerCase();   // 'simple' | 'otp'

/* ---------- AI sozlamalari (bepul: Groq) ---------- */
const AI_PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase(); // 'openai' (Groq/Gemini) | 'anthropic'
const AI_KEY = process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || (AI_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-latest' : 'llama-3.3-70b-versatile');

/* ---------- Oddiy JSON ma'lumotlar bazasi (native kompilyatsiyasiz) ---------- */
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'users.json');
let users = [];
try { users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { users = []; }
let saving = false, saveAgain = false;
function persist() {
  if (saving) { saveAgain = true; return; }
  saving = true;
  fs.writeFile(DB_FILE, JSON.stringify(users, null, 2), () => {
    saving = false;
    if (saveAgain) { saveAgain = false; persist(); }
  });
}

/* ---------- OTP (faqat AUTH_MODE=otp uchun; xotirada) ---------- */
const otps = {};
let eskizToken = null, eskizExp = 0;
async function eskizLogin() {
  if (eskizToken && Date.now() < eskizExp) return eskizToken;
  const body = new URLSearchParams({ email: process.env.ESKIZ_EMAIL, password: process.env.ESKIZ_PASSWORD });
  const r = await fetch('https://notify.eskiz.uz/api/auth/login', { method: 'POST', body });
  const d = await r.json();
  eskizToken = d.data && d.data.token;
  eskizExp = Date.now() + 25 * 24 * 60 * 60 * 1000;
  return eskizToken;
}
async function sendSMS(phone, text) {
  const num = (phone || '').replace(/\D/g, '');
  if (!process.env.ESKIZ_EMAIL || !process.env.ESKIZ_PASSWORD) {
    console.log('\n[DEV-SMS] ' + phone + '  =>  ' + text + '\n');
    return { dev: true };
  }
  const token = await eskizLogin();
  const body = new URLSearchParams({ mobile_phone: num, message: text, from: process.env.ESKIZ_FROM || '4546' });
  const r = await fetch('https://notify.eskiz.uz/api/message/sms/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body
  });
  return await r.json();
}

/* ---------- Yordamchilar ---------- */
function makeToken(u) { return jwt.sign({ id: u.id, phone: u.phone }, JWT_SECRET, { expiresIn: '60d' }); }
function normPhone(v) { let d = (v || '').replace(/\D/g, ''); if (d.startsWith('998')) d = d.slice(3); return d.length === 9 ? '+998' + d : null; }
function textFromContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (p && p.type === 'text') ? p.text : (typeof p === 'string' ? p : '')).filter(Boolean).join('\n');
  return '';
}

/* ============================ AUTH ============================ */
app.post('/api/register/start', async (req, res) => {
  try {
    const phone = normPhone(req.body.phone);
    const name = (req.body.name || '').trim();
    const password = req.body.password || '';
    if (!phone) return res.status(400).json({ error: 'Telefon raqam noto\'g\'ri' });

    /* ----- SIMPLE rejim: SMSsiz, hisobni darrov yaratamiz (BEPUL) ----- */
    if (AUTH_MODE !== 'otp') {
      if (password === '__resend__') return res.json({ ok: true });
      if (!name) return res.status(400).json({ error: 'Ismni kiriting' });
      if (password.length < 4) return res.status(400).json({ error: 'Parol juda qisqa' });
      if (users.some(u => u.phone === phone)) return res.status(409).json({ error: 'Bu raqam allaqachon ro\'yxatdan o\'tgan' });
      const hash = await bcrypt.hash(password, 10);
      const u = { id: Date.now(), phone, name, pass_hash: hash, created_at: Date.now() };
      users.push(u); persist();
      return res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name } });
    }

    /* ----- OTP rejim: SMS kod (Eskiz, pullik) ----- */
    if (password === '__resend__') {
      const o = otps[phone];
      if (!o) return res.status(400).json({ error: 'Avval ro\'yxatni boshlang' });
      o.code = String(Math.floor(100000 + Math.random() * 900000));
      o.exp = Date.now() + 5 * 60000;
      const s = await sendSMS(phone, 'Zako tasdiqlash kodi: ' + o.code);
      return res.json({ ok: true, dev: s.dev ? o.code : undefined });
    }
    if (!name) return res.status(400).json({ error: 'Ismni kiriting' });
    if (password.length < 4) return res.status(400).json({ error: 'Parol juda qisqa' });
    if (users.some(u => u.phone === phone)) return res.status(409).json({ error: 'Bu raqam allaqachon ro\'yxatdan o\'tgan' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await bcrypt.hash(password, 10);
    otps[phone] = { code, exp: Date.now() + 5 * 60000, name, hash, attempts: 0 };
    const s = await sendSMS(phone, 'Zako tasdiqlash kodi: ' + code);
    res.json({ ok: true, dev: s.dev ? code : undefined });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.post('/api/register/verify', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const code = (req.body.code || '').trim();
  const o = otps[phone];
  if (!o || o.exp < Date.now()) return res.status(400).json({ error: 'Kod muddati tugagan, qaytadan urinib ko\'ring' });
  if (o.attempts++ >= 5) { delete otps[phone]; return res.status(429).json({ error: 'Urinishlar ko\'p, qaytadan boshlang' }); }
  if (o.code !== code) return res.status(400).json({ error: 'Kod noto\'g\'ri' });
  const u = { id: Date.now(), phone, name: o.name, pass_hash: o.hash, created_at: Date.now() };
  users.push(u); persist(); delete otps[phone];
  res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name } });
});

app.post('/api/login', async (req, res) => {
  const phone = normPhone(req.body.phone);
  const password = req.body.password || '';
  const u = users.find(x => x.phone === phone);
  if (!u) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
  const ok = await bcrypt.compare(password, u.pass_hash);
  if (!ok) return res.status(401).json({ error: 'Raqam yoki parol noto\'g\'ri' });
  res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name } });
});

/* ============================ STATS ============================ */
app.get('/api/stats', (req, res) => {
  res.json({ users: users.length, threshold: PAID_THRESHOLD, paid_active: users.length >= PAID_THRESHOLD });
});
app.get('/api/health', (req, res) => res.json({ ok: true, ai: AI_KEY ? 'sozlangan' : 'yo\'q', provider: AI_PROVIDER }));

/* ============================ AI PROXY (kalit serverda qoladi) ============================ */
app.post('/api/chat', async (req, res) => {
  if (!AI_KEY) return res.status(500).json({ error: 'Server AI kaliti sozlanmagan (AI_API_KEY)' });
  const body = req.body || {};
  try {
    /* --- Anthropic (Claude) --- */
    if (AI_PROVIDER === 'anthropic') {
      const payload = Object.assign({ model: AI_MODEL, max_tokens: 1024 }, body);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }
    /* --- OpenAI-mos (Groq / Gemini / ...) --- */
    const msgs = [];
    if (body.system) msgs.push({ role: 'system', content: String(body.system) });
    (body.messages || []).forEach(m => msgs.push({ role: (m.role === 'assistant' ? 'assistant' : 'user'), content: textFromContent(m.content) }));
    const r = await fetch(AI_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY },
      body: JSON.stringify({ model: AI_MODEL, messages: msgs, max_tokens: body.max_tokens || 1024, temperature: 0.7 })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (data.error && (data.error.message || data.error)) || 'AI xatosi' });
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    // Frontend Anthropic javob shaklini kutadi:
    return res.json({ content: [{ type: 'text', text: text }] });
  } catch (e) { res.status(502).json({ error: 'AI xizmatiga ulanib bo\'lmadi' }); }
});

/* ============================ FRONTEND ============================ */
let HTML = '';
try {
  HTML = fs.readFileSync(path.join(__dirname, 'Zako.html'), 'utf8')
    .replace("const ZAKO_BACKEND=''", "const ZAKO_BACKEND='/api'");
} catch (e) { console.error('Zako.html topilmadi! server.js bilan bir papkada bo\'lsin.'); }
app.get('/', (req, res) => res.type('html').send(HTML));

app.listen(PORT, () => {
  console.log('\n  ✅ Zako server ishga tushdi:  http://localhost:' + PORT);
  console.log('  • AI provayder:    ' + AI_PROVIDER + ' (model: ' + AI_MODEL + ')');
  console.log('  • AI kaliti:       ' + (AI_KEY ? 'sozlangan ✓' : 'YO\'Q — AI_API_KEY qo\'shing'));
  console.log('  • Auth rejimi:     ' + AUTH_MODE + (AUTH_MODE === 'simple' ? ' (SMSsiz, bepul)' : ' (SMS kod)'));
  console.log('  • Pullik eshik:    ' + PAID_THRESHOLD + ' foydalanuvchi');
  console.log('  • Ro\'yxatdagilar:  ' + users.length + '\n');
});
