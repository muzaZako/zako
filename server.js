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
    else if (action === "delete") { await store.del(id); }
    else return res.status(400).json({ error: "Noma'lum amal" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Amalda xatolik: " + e.message.slice(0, 100) }); }
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
