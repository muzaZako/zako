/* ============================================================
   ZAKO — backend (toza versiya)
   • Telegram login  — bir bosishda kirish, kriptografik imzo tekshiriladi
   • Telefon (zaxira) — telefon + parol (bcrypt), kodsiz
   • AI proxy         — OpenAI-mos (OpenRouter / Groq), kalit serverda qoladi
   • Xavfsizlik       — JWT, bcrypt, rate-limit (brute-force himoyasi)
   Render env: AI_API_KEY, AI_BASE_URL, AI_MODEL,
               TG_BOT_TOKEN, TG_BOT_USERNAME, JWT_SECRET,
               SUPABASE_URL, SUPABASE_KEY  (doimiy baza — tavsiya etiladi!)
               ADMIN_KEY  (admin panel maxfiy kaliti — savol qo'shish uchun)
   Ishga tushirish:  npm install  &&  npm start
   ============================================================ */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
try { require("dotenv").config(); } catch (e) {}

const app = express();
app.use(express.json({ limit: "8mb" }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "ALMASHTIRING-uzun-maxfiy-kalit";
const PAID_THRESHOLD = parseInt(process.env.PAID_THRESHOLD || "50", 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "268299311368-v8luuom68f23e6goa1qlnc2mgk0pohgf.apps.googleusercontent.com";

/* ---------- AI (OpenAI-mos: OpenRouter / Groq) ---------- */
const AI_PROVIDER = (process.env.AI_PROVIDER || "openai").toLowerCase();
const AI_KEY = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY || "";
const AI_BASE = (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "openrouter/free";
const AI_MODELS = (process.env.AI_MODELS || [AI_MODEL, "deepseek/deepseek-chat-v3-0324:free", "meta-llama/llama-3.3-70b-instruct:free", "google/gemini-2.0-flash-exp:free"].join(",")).split(",").map(s => s.trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

/* ---------- Telegram login ---------- */
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_BOT_USERNAME = (process.env.TG_BOT_USERNAME || "").replace(/^@/, "");

/* ---------- Ma'lumotlar bazasi: Supabase (doimiy) yoki fayl (zaxira) ----------
   DIQQAT: Render bepul tarifida disk vaqtinchalik — users.json har deploy/restartda
   o'chadi. Doimiy saqlash uchun SUPABASE_URL va SUPABASE_KEY env qo'shing. */
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_KEY || "";
const DB_MODE = (SB_URL && SB_KEY) ? "supabase" : "file";

async function sbReq(pathq, opts) {
  opts = opts || {};
  const r = await fetch(SB_URL + "/rest/v1/" + pathq, {
    method: opts.method || "GET",
    headers: Object.assign({
      "apikey": SB_KEY,
      "Authorization": "Bearer " + SB_KEY,
      "Content-Type": "application/json"
    }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error("DB " + r.status + " " + t.slice(0, 180)); }
  if (opts.raw) return r;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

/* Fayl zaxirasi (Supabase sozlanmaganda) */
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "users.json");
let users = [];
try { users = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { users = []; }
let saving = false, saveAgain = false;
function persist() {
  if (saving) { saveAgain = true; return; }
  saving = true;
  fs.writeFile(DB_FILE, JSON.stringify(users, null, 2), () => {
    saving = false;
    if (saveAgain) { saveAgain = false; persist(); }
  });
}

/* Yagona interfeys — hamma marshrut shu orqali ishlaydi */
const store = DB_MODE === "supabase" ? {
  async findBy(field, value) {
    const rows = await sbReq("zako_users?" + field + "=eq." + encodeURIComponent(value) + "&select=*&limit=1");
    return (rows && rows[0]) || null;
  },
  async insert(u) { await sbReq("zako_users", { method: "POST", body: u, headers: { "Prefer": "return=minimal" } }); return u; },
  async update(id, fields) { await sbReq("zako_users?id=eq." + encodeURIComponent(id), { method: "PATCH", body: fields, headers: { "Prefer": "return=minimal" } }); },
  async count() {
    const r = await sbReq("zako_users?select=id&limit=1", { headers: { "Prefer": "count=exact" }, raw: true });
    const cr = r.headers.get("content-range") || "";
    await r.text().catch(() => "");
    const n = parseInt(cr.split("/")[1] || "0", 10);
    return isNaN(n) ? 0 : n;
  },
  async top(wk, limit) {
    return (await sbReq("zako_users?select=name,xp,week_xp&week_key=eq." + encodeURIComponent(wk) + "&week_xp=gt.0&order=week_xp.desc,xp.desc&limit=" + (limit || 20))) || [];
  },
  async listAll(limit) {
    return (await sbReq("zako_users?select=id,name,phone,email,xp,week_xp,prem_until,ref_count,blocked,last_login,created_at&order=created_at.desc&limit=" + (limit || 500))) || [];
  },
  async del(id) { await sbReq("zako_users?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: { "Prefer": "return=minimal" } }); }
} : {
  async findBy(field, value) { return users.find(x => String(x[field]) === String(value)) || null; },
  async insert(u) { users.push(u); persist(); return u; },
  async update(id, fields) { const u = users.find(x => String(x.id) === String(id)); if (u) { Object.assign(u, fields); persist(); } },
  async count() { return users.length; },
  async top(wk, limit) {
    return users.filter(u => u.week_key === wk && (u.week_xp || 0) > 0)
      .sort((a, b) => (b.week_xp || 0) - (a.week_xp || 0)).slice(0, limit || 20)
      .map(u => ({ name: u.name, xp: u.xp || 0, week_xp: u.week_xp || 0 }));
  },
  async listAll(limit) { return users.slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, limit || 500); },
  async del(id) { const i = users.findIndex(x => String(x.id) === String(id)); if (i > -1) { users.splice(i, 1); persist(); } }
};

/* Hafta kaliti — Toshkent (UTC+5) bo'yicha dushanba sanasi */
function weekKey() {
  const t = new Date(Date.now() + 5 * 3600 * 1000);
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day);
  return t.toISOString().slice(0, 10);
}
function authUserId(req) {
  try {
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!tok) return null;
    const p = jwt.verify(tok, JWT_SECRET);
    return (p && p.id) ? p.id : null;
  } catch (e) { return null; }
}
async function touchLogin(u){ try{ await store.update(u.id,{ last_login: Date.now() }); }catch(e){} }

/* ---------- Rate-limit (brute-force himoyasi) ---------- */
const hits = {};
function rateOk(key, max, windowMs) {
  const now = Date.now();
  if (!hits[key] || now > hits[key].reset) hits[key] = { n: 0, reset: now + windowMs };
  hits[key].n++;
  return hits[key].n <= max;
}
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.ip || "ip").split(",")[0].trim(); }

/* ---------- Yordamchilar ---------- */
function makeToken(u) { return jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: "60d" }); }
function looksLooping(t) { if (!t || t.length < 220) return false; var chunk = t.slice(-45).replace(/\s+/g, " ").trim(); if (chunk.length < 12) return false; return (t.split(chunk).length - 1) >= 6; }
function normPhone(v) { let d = (v || "").replace(/\D/g, ""); if (d.startsWith("998")) d = d.slice(3); return d.length === 9 ? "+998" + d : null; }
function textFromContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => (p && p.type === "text") ? p.text : (typeof p === "string" ? p : "")).filter(Boolean).join("\n");
  return "";
}

/* ============================ TELEGRAM LOGIN ============================ */
// Telegram Login Widget ma'lumotini bot tokeni bilan tekshiradi (rasmiy algoritm)
function checkTelegramAuth(data) {
  if (!TG_BOT_TOKEN) return false;
  const hash = data.hash;
  const pairs = Object.keys(data).filter(k => k !== "hash" && data[k] != null).sort().map(k => k + "=" + data[k]);
  const checkString = pairs.join(String.fromCharCode(10));
  const secret = crypto.createHash("sha256").update(TG_BOT_TOKEN).digest();
  const hmac = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  return hmac === hash;
}
app.post("/api/tg-auth", async (req, res) => {
  try {
    if (!rateOk("tg:" + clientIp(req), 20, 60000)) return res.status(429).json({ error: "Juda ko'p urinish, biroz kuting" });
    if (!TG_BOT_TOKEN) return res.status(500).json({ error: "Server Telegram sozlanmagan (TG_BOT_TOKEN)" });
    const data = req.body || {};
    if (!data.id || !data.hash) return res.status(400).json({ error: "Telegram ma'lumotlari to'liq emas" });
    if (!checkTelegramAuth(data)) return res.status(401).json({ error: "Telegram imzosi noto'g'ri" });
    if (data.auth_date && (Math.floor(Date.now() / 1000) - Number(data.auth_date) > 86400))
      return res.status(401).json({ error: "Telegram sessiyasi eskirgan, qaytadan kiring" });
    let u = await store.findBy("tg_id", data.id);
    if (!u) {
      const name = [data.first_name, data.last_name].filter(Boolean).join(" ").trim() || (data.username ? "@" + data.username : "Telegram foydalanuvchi");
      u = { id: Date.now(), tg_id: data.id, tg_username: data.username || "", phone: "tg:" + data.id, name: name, xp: 0, week_xp: 0, week_key: null, created_at: Date.now() };
      await store.insert(u);
    }
    if (u.blocked) return res.status(403).json({ error: "Hisobingiz bloklangan." });
    await touchLogin(u);
    res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name } });
  } catch (e) { res.status(500).json({ error: "Server xatosi (Telegram)" }); }
});

/* ============================ TELEFON (zaxira, kodsiz) ============================ */
app.post("/api/register/start", async (req, res) => {
  try {
    if (!rateOk("reg:" + clientIp(req), 10, 60000)) return res.status(429).json({ error: "Juda ko'p urinish, biroz kuting" });
    const phone = normPhone(req.body.phone);
    const name = (req.body.name || "").trim();
    const password = req.body.password || "";
    if (!phone) return res.status(400).json({ error: "Telefon raqam noto'g'ri" });
    if (password === "__resend__") return res.json({ ok: true });
    if (!name) return res.status(400).json({ error: "Ismni kiriting" });
    if (password.length < 4) return res.status(400).json({ error: "Parol juda qisqa" });
    if (await store.findBy("phone", phone)) return res.status(409).json({ error: "Bu raqam allaqachon ro'yxatdan o'tgan" });
    const hash = await bcrypt.hash(password, 10);
    const u = { id: Date.now(), phone: phone, name: name, pass_hash: hash, xp: 0, week_xp: 0, week_key: null, blocked: false, last_login: Date.now(), created_at: Date.now() };
    await store.insert(u);
    res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name } });
  } catch (e) { res.status(500).json({ error: "Server xatosi" }); }
});
app.post("/api/login", async (req, res) => {
  if (!rateOk("login:" + clientIp(req), 10, 60000)) return res.status(429).json({ error: "Juda ko'p urinish, biroz kuting" });
  const phone = normPhone(req.body.phone);
  const password = req.body.password || "";
  const u = await store.findBy("phone", phone);
  if (!u || !u.pass_hash) return res.status(404).json({ error: "Foydalanuvchi topilmadi" });
  const ok = await bcrypt.compare(password, u.pass_hash);
  if (!ok) return res.status(401).json({ error: "Raqam yoki parol noto'g'ri" });
  if (u.blocked) return res.status(403).json({ error: "Hisobingiz bloklangan. Qo'llab-quvvatlashga murojaat qiling." });
  await touchLogin(u);
  res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name } });
});

/* ============================ GOOGLE LOGIN ============================ */
app.post("/api/google-auth", async (req, res) => {
  try {
    if (!rateOk("g:" + clientIp(req), 20, 60000)) return res.status(429).json({ error: "Juda ko'p urinish, biroz kuting" });
    const idToken = req.body.credential || req.body.id_token || "";
    if (!idToken) return res.status(400).json({ error: "Token yo'q" });
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!r.ok) return res.status(401).json({ error: "Google tokeni tekshiruvdan o'tmadi" });
    const p = await r.json();
    if (String(p.aud) !== String(GOOGLE_CLIENT_ID)) return res.status(401).json({ error: "Token boshqa ilovaga tegishli" });
    if (!p.email) return res.status(401).json({ error: "Email topilmadi" });
    let u = (p.sub ? await store.findBy("google_sub", p.sub) : null) || (p.email ? await store.findBy("email", p.email) : null);
    if (!u) {
      u = { id: Date.now(), google_sub: p.sub, email: p.email, phone: "google:" + p.sub, name: p.name || (p.email.split("@")[0]), avatar: p.picture || "", xp: 0, week_xp: 0, week_key: null, created_at: Date.now() };
      await store.insert(u);
    }
    if (u.blocked) return res.status(403).json({ error: "Hisobingiz bloklangan." });
    await touchLogin(u);
    res.json({ token: makeToken(u), user: { phone: u.phone, name: u.name, email: u.email } });
  } catch (e) { res.status(500).json({ error: "Server xatosi (Google)" }); }
});

/* ============================ CONFIG / STATS ============================ */
// Frontend bot username ni shu yerdan ishonchli oladi (tugma chiqishi uchun)
app.get("/api/config", (req, res) => res.json({ tg_bot: TG_BOT_USERNAME, google_client_id: GOOGLE_CLIENT_ID, paid_threshold: PAID_THRESHOLD }));
app.get("/api/stats", async (req, res) => { try { const n = await store.count(); res.json({ users: n, threshold: PAID_THRESHOLD, paid_active: n >= PAID_THRESHOLD }); } catch (e) { res.json({ users: 0, threshold: PAID_THRESHOLD, paid_active: false }); } });
app.get("/api/health", (req, res) => res.json({ ok: true, ai: AI_KEY ? "sozlangan" : "yo'q", telegram: (TG_BOT_TOKEN && TG_BOT_USERNAME) ? "ulangan" : "yo'q" }));

/* ============================ XP SINXRON & HAQIQIY REYTING ============================ */
// Kirgan foydalanuvchi XP'sini serverga yozadi (oddiy himoya: chegara + faqat o'sish)
app.post("/api/xp", async (req, res) => {
  try {
    if (!rateOk("xp:" + clientIp(req), 30, 60000)) return res.status(429).json({ error: "Juda ko'p so'rov" });
    const uid = authUserId(req);
    if (!uid) return res.status(401).json({ error: "Avval hisobingizga kiring" });
    const u = await store.findBy("id", uid);
    if (!u) return res.status(404).json({ error: "Foydalanuvchi topilmadi" });
    const wk = weekKey();
    let xp = parseInt(req.body && req.body.xp, 10); if (isNaN(xp)) xp = 0;
    let wxp = parseInt(req.body && req.body.weekXP, 10); if (isNaN(wxp)) wxp = 0;
    xp = Math.max(0, Math.min(xp, 2000000));
    wxp = Math.max(0, Math.min(wxp, 20000));
    const newXp = Math.max(u.xp || 0, xp);
    const newWxp = (u.week_key === wk) ? Math.max(u.week_xp || 0, wxp) : wxp;
    await store.update(u.id, { xp: newXp, week_xp: newWxp, week_key: wk });
    res.json({ ok: true, xp: newXp, week_xp: newWxp, week: wk });
  } catch (e) { res.status(500).json({ error: "Server xatosi (XP)" }); }
});
// Joriy hafta bo'yicha TOP-20 (hamma ko'ra oladi)
app.get("/api/leaderboard", async (req, res) => {
  try {
    const wk = weekKey();
    const top = await store.top(wk, 20);
    const total = await store.count();
    res.json({ week: wk, top: top || [], total: total });
  } catch (e) { res.status(500).json({ error: "Reytingni olib bo'lmadi" }); }
});
/* ============================ REFERRAL (do'st taklif -> premium kunlar) ============================ */
function refCodeOf(u) { return Number(u.id).toString(36); }
function isPremium(u) { return !!(u && u.prem_until && Number(u.prem_until) > Date.now()); }
function addPremDays(u, days) {
  const base = (u.prem_until && Number(u.prem_until) > Date.now()) ? Number(u.prem_until) : Date.now();
  return base + days * 86400 * 1000;
}
// Joriy foydalanuvchi holati (premium + havola kodi + statistika)
app.get("/api/me", async (req, res) => {
  try {
    const uid = authUserId(req);
    if (!uid) return res.status(401).json({ error: "Kirilmagan" });
    const u = await store.findBy("id", uid);
    if (!u) return res.status(404).json({ error: "Topilmadi" });
    res.json({ premium: isPremium(u), prem_until: Number(u.prem_until) || 0, ref_code: refCodeOf(u), ref_count: u.ref_count || 0, name: u.name, blocked: !!u.blocked });
  } catch (e) { res.status(500).json({ error: "Server xatosi" }); }
});
// Havola qo'llash: yangi foydalanuvchi + taklif qiluvchi — ikkalasiga +7 kun
app.post("/api/referral/apply", async (req, res) => {
  try {
    if (!rateOk("ref:" + clientIp(req), 20, 60000)) return res.status(429).json({ error: "Juda ko'p urinish" });
    const uid = authUserId(req);
    if (!uid) return res.status(401).json({ error: "Avval hisobingizga kiring" });
    const me = await store.findBy("id", uid);
    if (!me) return res.status(404).json({ error: "Topilmadi" });
    if (me.ref_by) return res.json({ premium: isPremium(me), prem_until: Number(me.prem_until) || 0, already: true });
    const code = String((req.body && req.body.code) || "").trim().toLowerCase();
    const refId = parseInt(code, 36);
    if (!code || isNaN(refId) || refId === Number(me.id)) return res.status(400).json({ error: "Havola yaroqsiz" });
    const inviter = await store.findBy("id", refId);
    if (!inviter) return res.status(404).json({ error: "Taklif qiluvchi topilmadi" });
    const DAYS = 7;
    await store.update(me.id, { ref_by: Number(inviter.id), prem_until: addPremDays(me, DAYS) });
    const cnt = (inviter.ref_count || 0);
    const invFields = { ref_count: cnt + 1 };
    if (cnt < 100) invFields.prem_until = addPremDays(inviter, DAYS); // suiiste'molga qarshi yumshoq chegara
    await store.update(inviter.id, invFields);
    const me2 = await store.findBy("id", uid);
    res.json({ premium: isPremium(me2), prem_until: Number(me2.prem_until) || 0, granted: DAYS });
  } catch (e) { res.status(500).json({ error: "Server xatosi (referral)" }); }
});



/* ============================ ADMIN: SAVOLLAR BOSHQARUVI ============================ */
const ADMIN_KEY = process.env.ADMIN_KEY || "";
function adminOk(req) { return !!(ADMIN_KEY && String(req.headers["x-admin-key"] || "") === ADMIN_KEY); }
async function qList(approvedOnly) {
  if (DB_MODE !== "supabase") return [];
  const path = approvedOnly
    ? "zako_questions?approved=eq.true&select=*&order=created_at.desc&limit=2000"
    : "zako_questions?select=*&order=created_at.desc&limit=2000";
  return (await sbReq(path)) || [];
}
async function qInsert(row) { if (DB_MODE !== "supabase") throw new Error("Supabase sozlanmagan"); await sbReq("zako_questions", { method: "POST", body: row, headers: { "Prefer": "return=minimal" } }); }
async function qDelete(id) { if (DB_MODE !== "supabase") throw new Error("Supabase sozlanmagan"); await sbReq("zako_questions?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: { "Prefer": "return=minimal" } }); }

// Ommaviy: tasdiqlangan qo'shimcha savollar (frontend QB'ga qo'shadi)
app.get("/api/questions", async (req, res) => {
  try {
    const items = await qList(true);
    res.json({ items: items.map(r => ({ id: r.id, subj: r.subj, q: r.q, o: r.o, a: r.a, d: r.d, e: r.e || "" })) });
  } catch (e) { res.json({ items: [] }); }
});
// Admin kalitini tekshirish
app.post("/api/admin/verify", (req, res) => {
  if (!ADMIN_KEY) return res.json({ ok: false, configured: false });
  res.json({ ok: adminOk(req), configured: true });
});
// Admin: barcha savollar ro'yxati
app.get("/api/admin/questions", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try { res.json({ items: await qList(false) }); } catch (e) { res.status(500).json({ error: "Baza xatosi" }); }
});
// Admin: yangi savol qo'shish
app.post("/api/admin/questions", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try {
    const b = req.body || {};
    const subj = String(b.subj || "").trim();
    const q = String(b.q || "").trim();
    const o = Array.isArray(b.o) ? b.o.map(x => String(x == null ? "" : x).trim()) : [];
    const a = parseInt(b.a, 10);
    const d = ["easy", "med", "hard"].includes(b.d) ? b.d : "med";
    const e = String(b.e || "").trim();
    if (!subj || q.length < 5 || o.length !== 4 || o.some(x => !x) || !(a >= 0 && a < 4))
      return res.status(400).json({ error: "Ma'lumot to'liq emas (savol, 4 variant, to'g'ri javob)" });
    const row = { id: Date.now(), subj, q, o, a, d, e, approved: true, created_at: Date.now() };
    await qInsert(row);
    res.json({ ok: true, item: row });
  } catch (e) { res.status(500).json({ error: "Saqlashda xatolik: " + e.message.slice(0, 120) }); }
});
// Admin: savolni o'chirish
app.delete("/api/admin/questions", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try { await qDelete(req.query.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: "O'chirishda xatolik" }); }
});


// Admin: savollarni ommaviy import (bir so'rovda ko'p savol)
app.post("/api/admin/questions/bulk", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try {
    const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Savollar yo'q" });
    if (items.length > 200) return res.status(400).json({ error: "Bir martada ko'pi bilan 200 ta" });
    const rows = [], errors = [];
    const base = Date.now();
    items.forEach((b, i) => {
      const subj = String(b.subj || "").trim();
      const q = String(b.q || "").trim();
      const o = Array.isArray(b.o) ? b.o.map(x => String(x == null ? "" : x).trim()) : [];
      const a = parseInt(b.a, 10);
      const d = ["easy", "med", "hard"].includes(b.d) ? b.d : "hard";
      const e = String(b.e || "").trim();
      if (!subj || q.length < 5 || o.length !== 4 || o.some(x => !x) || !(a >= 0 && a < 4)) { errors.push(i + 1); return; }
      rows.push({ id: base + i, subj, q, o, a, d, e, approved: true, created_at: base + i });
    });
    if (!rows.length) return res.status(400).json({ error: "Hech bir savol formatga mos emas", bad: errors });
    if (DB_MODE !== "supabase") return res.status(400).json({ error: "Ommaviy import uchun Supabase kerak" });
    await sbReq("zako_questions", { method: "POST", body: rows, headers: { "Prefer": "return=minimal" } });
    res.json({ ok: true, added: rows.length, bad: errors });
  } catch (e) { res.status(500).json({ error: "Saqlashda xatolik: " + String(e.message || "").slice(0, 120) }); }
});
// Admin: umumiy statistika
app.get("/api/admin/stats", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try {
    const list = await store.listAll(3000);
    const now = Date.now(), wkAgo = now - 7 * 86400 * 1000;
    let prem = 0, blk = 0, txp = 0, neww = 0;
    list.forEach(u => { if (u.prem_until && Number(u.prem_until) > now) prem++; if (u.blocked) blk++; txp += (u.xp || 0); if ((Number(u.created_at) || 0) > wkAgo) neww++; });
    res.json({ users: list.length, premium: prem, blocked: blk, totalXp: txp, newWeek: neww, db: DB_MODE });
  } catch (e) { res.status(500).json({ error: "Baza xatosi" }); }
});
// Admin: foydalanuvchilar ro'yxati (qidiruv bilan)
app.get("/api/admin/users", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    let list = await store.listAll(3000);
    if (q) list = list.filter(u => ((u.name || "") + " " + (u.phone || "") + " " + (u.email || "")).toLowerCase().includes(q));
    res.json({ items: list.slice(0, 300).map(u => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || "", xp: u.xp || 0, week_xp: u.week_xp || 0, prem_until: Number(u.prem_until) || 0, ref_count: u.ref_count || 0, blocked: !!u.blocked, last_login: Number(u.last_login) || 0, created_at: Number(u.created_at) || 0 })) });
  } catch (e) { res.status(500).json({ error: "Baza xatosi" }); }
});
// Admin: foydalanuvchi ustida amal (blok, premium, xp, nom, o'chirish)
app.post("/api/admin/user", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try {
    const b = req.body || {}; const id = b.id; const action = String(b.action || "");
    if (!id) return res.status(400).json({ error: "id yo'q" });
    const u = await store.findBy("id", id);
    if (!u) return res.status(404).json({ error: "Topilmadi" });
    const now = Date.now();
    if (action === "block") await store.update(id, { blocked: true });
    else if (action === "unblock") await store.update(id, { blocked: false });
    else if (action === "premium") { const days = parseInt(b.days, 10) || 0; const base = (u.prem_until && Number(u.prem_until) > now) ? Number(u.prem_until) : now; await store.update(id, { prem_until: base + days * 86400 * 1000 }); }
    else if (action === "premoff") await store.update(id, { prem_until: 0 });
    else if (action === "xp") { const xp = Math.max(0, parseInt(b.xp, 10) || 0); await store.update(id, { xp: xp, week_xp: 0 }); }
    else if (action === "rename") { const nm = String(b.name || "").trim().slice(0, 60); if (nm) await store.update(id, { name: nm }); }
    else if (action === "temppass") {
      const tmp = Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10);
      const hash = await bcrypt.hash(tmp, 10);
      await store.update(id, { pass_hash: hash });
      return res.json({ ok: true, temp: tmp });
    }
    else if (action === "delete") { await store.del(id); }
    else return res.status(400).json({ error: "Noma'lum amal" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Amalda xatolik: " + e.message.slice(0, 100) }); }
});


/* ============================ XATO SAVOL XABARLARI ============================ */
const REPORTS_MEM = [];
async function repList() {
  if (DB_MODE === "supabase") return (await sbReq("zako_reports?select=*&order=created_at.desc&limit=300")) || [];
  return REPORTS_MEM.slice(0, 300);
}
// Ommaviy: xato haqida xabar berish
app.post("/api/report", async (req, res) => {
  try {
    if (!rateOk("rep:" + clientIp(req), 8, 60000)) return res.status(429).json({ error: "Juda ko'p xabar, biroz kuting" });
    const b = req.body || {};
    const q = String(b.q || "").trim().slice(0, 400);
    const subj = String(b.subj || "").trim().slice(0, 30);
    const reason = String(b.reason || "").trim().slice(0, 300);
    if (q.length < 8) return res.status(400).json({ error: "Savol matni yo'q" });
    const row = { id: Date.now(), subj, q, reason, user_id: authUserId(req) || null, status: "new", created_at: Date.now() };
    if (DB_MODE === "supabase") { await sbReq("zako_reports", { method: "POST", body: row, headers: { "Prefer": "return=minimal" } }); }
    else { REPORTS_MEM.unshift(row); if (REPORTS_MEM.length > 200) REPORTS_MEM.length = 200; }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Saqlab bo'lmadi" }); }
});
// Admin: xabarlar ro'yxati
app.get("/api/admin/reports", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try { res.json({ items: await repList() }); } catch (e) { res.status(500).json({ error: "Baza xatosi" }); }
});
// Admin: xabar ustida amal (done / delete)
app.post("/api/admin/report", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "Ruxsat yo'q" });
  try {
    const b = req.body || {}; const id = b.id; const action = String(b.action || "");
    if (!id) return res.status(400).json({ error: "id yo'q" });
    if (DB_MODE === "supabase") {
      if (action === "delete") await sbReq("zako_reports?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: { "Prefer": "return=minimal" } });
      else await sbReq("zako_reports?id=eq." + encodeURIComponent(id), { method: "PATCH", body: { status: "done" }, headers: { "Prefer": "return=minimal" } });
    } else {
      const i = REPORTS_MEM.findIndex(x => String(x.id) === String(id));
      if (i > -1) { if (action === "delete") REPORTS_MEM.splice(i, 1); else REPORTS_MEM[i].status = "done"; }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Amalda xatolik" }); }
});


/* ============================ FOYDALANUVCHI O'Z PROFILI ============================ */
app.post("/api/me/update", async (req, res) => {
  const uid = authUserId(req);
  if (!uid) return res.status(401).json({ error: "Avtorizatsiya kerak" });
  try {
    const u = await store.findBy("id", uid);
    if (!u) return res.status(404).json({ error: "Topilmadi" });
    if (u.blocked) return res.status(403).json({ error: "Hisob bloklangan" });
    const name = String((req.body || {}).name || "").trim().slice(0, 40);
    if (name.length < 2) return res.status(400).json({ error: "Ism juda qisqa" });
    await store.update(uid, { name });
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ error: "Saqlab bo'lmadi" }); }
});
app.post("/api/me/password", async (req, res) => {
  const uid = authUserId(req);
  if (!uid) return res.status(401).json({ error: "Avtorizatsiya kerak" });
  try {
    const u = await store.findBy("id", uid);
    if (!u || !u.pass_hash) return res.status(404).json({ error: "Parol o'rnatilmagan" });
    const b = req.body || {};
    const cur = String(b.current || ""), nxt = String(b.next || "");
    if (nxt.length < 6) return res.status(400).json({ error: "Yangi parol kamida 6 ta belgi" });
    const ok = await bcrypt.compare(cur, u.pass_hash);
    if (!ok) return res.status(401).json({ error: "Joriy parol noto'g'ri" });
    await store.update(uid, { pass_hash: await bcrypt.hash(nxt, 10) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "O'zgartirib bo'lmadi" }); }
});
app.post("/api/me/delete", async (req, res) => {
  const uid = authUserId(req);
  if (!uid) return res.status(401).json({ error: "Avtorizatsiya kerak" });
  try { await store.del(uid); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: "O'chirib bo'lmadi" }); }
});

/* ============================ AI PROXY (kalit serverda qoladi) ============================ */
app.post("/api/chat", async (req, res) => {
  if (!rateOk("chat:" + clientIp(req), 40, 60000)) return res.status(429).json({ error: "Juda ko'p so'rov, biroz kuting" });
  if (!AI_KEY) return res.status(500).json({ error: "Server AI kaliti sozlanmagan (AI_API_KEY)" });
  const body = req.body || {};
  try {
    if (AI_PROVIDER === "anthropic") {
      const payload = Object.assign({ model: AI_MODEL, max_tokens: 1600, temperature: 0.25 }, body);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(payload)
      });
      return res.status(r.status).json(await r.json());
    }
    const msgs = [];
    if (body.system) msgs.push({ role: "system", content: String(body.system) });
    (body.messages || []).forEach(m => msgs.push({ role: (m.role === "assistant" ? "assistant" : "user"), content: textFromContent(m.content) }));
    const maxTok = Math.min(parseInt(body.max_tokens, 10) || 1400, 2000);
    let lastErr = "AI hozir javob bera olmadi, qaytadan urinib ko'ring";
    for (const model of AI_MODELS) {
      try {
        const r = await fetch(AI_BASE + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AI_KEY },
          body: JSON.stringify({ model: model, messages: msgs, max_tokens: maxTok, temperature: 0.25, top_p: 0.9 })
        });
        const data = await r.json();
        if (!r.ok) { lastErr = (data.error && (data.error.message || data.error)) || lastErr; continue; }
        const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
        if (text && !looksLooping(text)) return res.json({ content: [{ type: "text", text: text }] });
        lastErr = text ? "Model sifatsiz javob qaytardi" : "Model bo'sh javob qaytardi";
      } catch (e) { lastErr = "AI xizmatiga ulanib bo'lmadi"; }
    }
    return res.status(502).json({ error: lastErr });
  } catch (e) { res.status(502).json({ error: "AI xizmatiga ulanib bo'lmadi" }); }
});

/* ============================ RASMDAN YECHISH (vision) ============================ */
const VISION_MODELS = process.env.AI_VISION_MODEL
  ? [process.env.AI_VISION_MODEL]
  : ["meta-llama/llama-3.2-11b-vision-instruct:free", "qwen/qwen-2-vl-7b-instruct:free"];
app.post("/api/vision", async (req, res) => {
  if (!rateOk("vis:" + clientIp(req), 6, 60000)) return res.status(429).json({ error: "Juda ko'p so'rov, biroz kuting" });
  if (!AI_KEY) return res.status(500).json({ error: "Server AI kaliti sozlanmagan" });
  const b = req.body || {};
  const img = String(b.image || "");
  const m = img.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Rasm formati noto'g'ri (png/jpg/webp)" });
  if (img.length > 6000000) return res.status(400).json({ error: "Rasm juda katta" });
  const prompt = String(b.prompt || "").slice(0, 1200) || "Rasmdagi masalani o'qib, bosqichma-bosqich yech.";
  const sys = String(b.system || "").slice(0, 3000);
  try {
    if (AI_PROVIDER === "anthropic") {
      const mt = "image/" + (m[1] === "jpg" ? "jpeg" : m[1]);
      const payload = { model: AI_MODEL, max_tokens: 1500, temperature: 0.2, system: sys,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mt, data: m[2] } }, { type: "text", text: prompt }] }] };
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(payload)
      });
      return res.status(r.status).json(await r.json());
    }
    const msgs = [];
    if (sys) msgs.push({ role: "system", content: sys });
    msgs.push({ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: img } }] });
    let lastErr = "Vision modeli hozir javob bera olmadi";
    for (const model of VISION_MODELS) {
      try {
        const r = await fetch(AI_BASE + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AI_KEY },
          body: JSON.stringify({ model: model, messages: msgs, max_tokens: 1500, temperature: 0.2 })
        });
        const data = await r.json();
        if (!r.ok) { lastErr = (data.error && (data.error.message || data.error)) || lastErr; continue; }
        const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
        if (text) return res.json({ content: [{ type: "text", text: text }] });
        lastErr = "Model bo'sh javob qaytardi";
      } catch (e) { lastErr = "Vision xizmatiga ulanib bo'lmadi"; }
    }
    return res.status(502).json({ error: lastErr });
  } catch (e) { res.status(502).json({ error: "Vision xizmatiga ulanib bo'lmadi" }); }
});

/* ============================ VALYUTA KURSI (Markaziy bank, kesh) ============================ */
let FX_CACHE = { t: 0, data: null };
app.get("/api/fx", async (req, res) => {
  try {
    if (FX_CACHE.data && Date.now() - FX_CACHE.t < 6 * 3600 * 1000) return res.json(FX_CACHE.data);
    const r = await fetch("https://cbu.uz/uz/arkhiv-kursov-valyut/json/", { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("CBU " + r.status);
    const all = await r.json();
    const want = ["USD", "EUR", "RUB"];
    const rates = all.filter(x => want.includes(x.Ccy)).map(x => ({
      ccy: x.Ccy, rate: parseFloat(x.Rate) || 0, diff: parseFloat(x.Diff) || 0, nominal: parseInt(x.Nominal, 10) || 1
    }));
    if (!rates.length) throw new Error("bo'sh");
    const out = { date: (all[0] && all[0].Date) || "", rates, src: "cbu.uz" };
    FX_CACHE = { t: Date.now(), data: out };
    res.set("Cache-Control", "public, max-age=1800").json(out);
  } catch (e) {
    if (FX_CACHE.data) return res.json(FX_CACHE.data);
    res.status(502).json({ error: "Kurslarni olib bo'lmadi" });
  }
});

/* ============================ FRONTEND ============================ */
let HTML = "";
try {
  HTML = fs.readFileSync(path.join(__dirname, "Zako.html"), "utf8")
    .replace("const ZAKO_BACKEND=''", "const ZAKO_BACKEND='/api'")
    .replace("const ZAKO_TG_BOT=''", "const ZAKO_TG_BOT='" + TG_BOT_USERNAME + "'");
} catch (e) { console.error("Zako.html topilmadi! server.js bilan bir papkada bo'lsin."); }
/* ============================ PWA (telefon ilovasi) ============================ */
const ICON192_B64 = "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";
const ICON512_B64 = "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";
const MANIFEST = JSON.stringify({
  name: "Zako — So'rang, Zako biladi",
  short_name: "Zako",
  description: "O'zbek tilidagi AI yordamchi platformasi — 6 soha bir joyda",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0e0e1a",
  theme_color: "#5b4be8",
  orientation: "portrait-primary",
  lang: "uz",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
});
const SW_JS = `const C='zako-v1';
self.addEventListener('install',function(e){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==C;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  var u=new URL(e.request.url);
  if(u.pathname.indexOf('/api/')===0)return;
  e.respondWith(fetch(e.request).then(function(r){var cp=r.clone();caches.open(C).then(function(c){c.put(e.request,cp);});return r;}).catch(function(){return caches.match(e.request).then(function(m){return m||caches.match('/');});}));
});`;
app.get("/manifest.webmanifest", (req, res) => res.type("application/manifest+json").send(MANIFEST));
app.get("/sw.js", (req, res) => { res.set("Cache-Control", "no-cache"); res.type("application/javascript").send(SW_JS); });
app.get("/icon-192.png", (req, res) => { res.type("png").set("Cache-Control", "public, max-age=604800").send(Buffer.from(ICON192_B64, "base64")); });
app.get("/icon-512.png", (req, res) => { res.type("png").set("Cache-Control", "public, max-age=604800").send(Buffer.from(ICON512_B64, "base64")); });
/* ============================ SEO: OG rasm, robots, sitemap ============================ */
const OG_B64 = "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";
app.get("/og.png", (req, res) => { res.type("png").set("Cache-Control", "public, max-age=604800").send(Buffer.from(OG_B64, "base64")); });
app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send("User-agent: *\nAllow: /\nSitemap: https://zako-uz.onrender.com/sitemap.xml\n");
});
app.get("/sitemap.xml", (req, res) => {
  res.type("application/xml").send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://zako-uz.onrender.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>');
});


/* ============================ UYQUGA KETMASLIK (keep-alive) ============================
   Render bepul tarifida server 15 daqiqa harakatsiz tursa "uxlaydi" va keyingi tashrifchi
   40-60 soniya kutadi. Quyidagi yengil /api/ping marshruti tashqi cron xizmati (masalan
   cron-job.org) tomonidan har 10 daqiqada chaqiriladi va serverni uyg'oq tutadi.
   Qo'shimcha himoya: server o'zini ham vaqti-vaqti bilan "turtib" turadi (RENDER_URL bo'lsa). */
app.get("/api/ping", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, alive: true, ts: Date.now(), uptime: Math.round(process.uptime()) });
});

// O'z-o'zini uyg'otish (ixtiyoriy): RENDER_URL yoki RENDER_EXTERNAL_URL env bo'lsa ishlaydi
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.RENDER_URL || "").replace(/\/+$/, "");
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL + "/api/ping").catch(() => {});
  }, 12 * 60 * 1000); // har 12 daqiqada
  console.log("  \u2022 Keep-alive:      yoqilgan (" + SELF_URL + ")");
}

app.get("/", (req, res) => res.type("html").send(HTML));

app.listen(PORT, () => {
  console.log("\n  \u2705 Zako server ishga tushdi:  http://localhost:" + PORT);
  console.log("  \u2022 AI:              " + (AI_KEY ? ("ulangan \u2713 (" + AI_MODELS.join(", ") + ")") : "YO'Q \u2014 AI_API_KEY qo'shing"));
  console.log("  \u2022 Telegram login:  " + (TG_BOT_TOKEN && TG_BOT_USERNAME ? ("ulangan \u2713 @" + TG_BOT_USERNAME) : "YO'Q \u2014 TG_BOT_TOKEN va TG_BOT_USERNAME qo'shing"));
  console.log("  \u2022 Baza:            " + (DB_MODE === "supabase" ? "Supabase \u2014 doimiy \u2713" : "users.json \u2014 Renderda O'CHIB KETADI! SUPABASE_URL/KEY qo'shing"));
  if (DB_MODE === "supabase") { store.count().then(n => console.log("  \u2022 Ro'yxatdagilar:  " + n + "\n")).catch(e => console.log("  \u2022 Baza xatosi: " + e.message + "\n")); }
  else { console.log("  \u2022 Ro'yxatdagilar:  " + users.length + "\n"); }
});
