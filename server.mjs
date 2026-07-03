/**
 * RoamSIM WhatsApp Bot — server.mjs (single-file Express server, no build step)
 * Env: PORT, PAYMENT_LINK, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM,
 *      ADMIN_WHATSAPP, ADMIN_KEY, DATABASE_URL (optional Postgres),
 *      AIRALO_CLIENT_ID, AIRALO_CLIENT_SECRET, AIRALO_BASE_URL (optional).
 */
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import https from "https";
import { dashboardHtml } from "./dashboard.mjs";

// ── WhatsApp (Twilio) messaging ──
function sendWhatsApp(to, message, mediaUrl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from || !to) {
    console.log("[WHATSAPP SEND - not configured]", to, message);
    return Promise.resolve();
  }
  const params = { From: from, To: to, Body: message };
  if (mediaUrl) params.MediaUrl = mediaUrl;
  const payload = new URLSearchParams(params).toString();
  const options = {
    hostname: "api.twilio.com",
    path: `/2010-04-01/Accounts/${sid}/Messages.json`,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
    },
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) console.error("[WHATSAPP SEND ERROR]", res.statusCode, data);
        resolve();
      });
    });
    req.on("error", (e) => { console.error("[WHATSAPP SEND ERROR]", e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}
function notifyAdmin(message) {
  const to = process.env.ADMIN_WHATSAPP;
  if (!to) { console.log("[ADMIN NOTIFY - not configured]", message); return Promise.resolve(); }
  return sendWhatsApp(to, message);
}

// ── Airalo Partner API (eSIM auto-provisioning) ──
const AIRALO_BASE = process.env.AIRALO_BASE_URL || "https://partners-api.airalo.com";
// Map catalog plan id -> Airalo package_id. Populate from /api/admin/airalo/packages.
const PLAN_TO_AIRALO_PACKAGE = {
  "uk-5gb-7d": "uki-mobile-in-30days-5gb",
  "uk-15gb-30d": "uki-mobile-in-30days-20gb",
  "uk-unlimited-30d": "uki-mobile-30days-unlimited",
  "uae-5gb-7d": "burj-mobile-30days-5gb",
  "uae-15gb-30d": "burj-mobile-30days-10gb",
  "uae-30gb-30d": "burj-mobile-30days-20gb",
  "aus-5gb-14d": "yes-go-in-30days-5gb",
  "aus-15gb-30d": "yes-go-in-30days-20gb",
  "aus-unlimited-30d": "yes-go-in-30days-unlimited",
  "us-5gb-7d": "change-in-30days-5gb",
  "us-15gb-30d": "change-in-30days-20gb",
  "us-unlimited-30d": "change-in-30days-unlimited",
  "eu-5gb-14d": "eurolink-30days-5gb",
  "eu-15gb-30d": "eurolink-30days-20gb",
  "eu-unlimited-30d": "eurolink-30days-unlimited",
  "ksa-5gb-14d": "red-sand-30days-5gb",
  "ksa-15gb-30d": "red-sand-30days-10gb",
  "ksa-30gb-30d": "red-sand-30days-20gb",
};
let airaloTokenCache = { token: null, expiresAt: 0 };
function airaloHttp(method, path, { token, form } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(AIRALO_BASE + path);
    const body = form ? new URLSearchParams(form).toString() : null;
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const options = { hostname: url.hostname, path: url.pathname + url.search, method, headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        if (res.statusCode >= 400) return reject(new Error(`Airalo ${method} ${path} -> ${res.statusCode}: ${data.slice(0, 300)}`));
        resolve(json);
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
async function getAiraloToken() {
  const id = process.env.AIRALO_CLIENT_ID;
  const secret = process.env.AIRALO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Airalo credentials not configured");
  if (airaloTokenCache.token && Date.now() < airaloTokenCache.expiresAt) return airaloTokenCache.token;
  const res = await airaloHttp("POST", "/v2/token", {
    form: { client_id: id, client_secret: secret, grant_type: "client_credentials" },
  });
  const token = res?.data?.access_token;
  if (!token) throw new Error("Airalo token missing in response");
  airaloTokenCache = { token, expiresAt: Date.now() + (res?.data?.expires_in || 86400) * 1000 - 60000 };
  return token;
}
async function airaloListPackages(country, type) {
  const token = await getAiraloToken();
  const params = ["limit=100"];
  if (country) params.push("filter[country]=" + encodeURIComponent(country));
  if (type) params.push("filter[type]=" + encodeURIComponent(type));
  return airaloHttp("GET", "/v2/packages?" + params.join("&"), { token });
}
async function airaloSubmitOrder(packageId, description, toEmail) {
  const token = await getAiraloToken();
  const form = { package_id: packageId, quantity: 1, type: "sim", description: description || "RoamSIM order" };
  if (toEmail) form.to_email = toEmail;
  return airaloHttp("POST", "/v2/orders", { token, form });
}
async function fulfillOrder(order) {
  const packageId = PLAN_TO_AIRALO_PACKAGE[order.planId];
  if (!packageId) throw new Error(`No Airalo package mapped for plan "${order.planId}" — update PLAN_TO_AIRALO_PACKAGE`);
  // Note: to_email omitted — Airalo's eSIM Cloud email isn't enabled, and it
  // causes order rejection. We deliver the QR via WhatsApp instead.
  const res = await airaloSubmitOrder(packageId, order.reference);
  const sim = res?.data?.sims?.[0];
  if (!sim) throw new Error("Airalo order returned no SIM");
  const lines = [
    `🎉 *Your RoamSIM eSIM for ${order.destinationName} is ready!*`,
    ``,
    `📦 ${order.planName}`,
    `🔖 Ref: ${order.reference}`,
    ``,
    `📲 *Install:* scan the QR code image above in your phone's eSIM settings (Settings → Mobile/Cellular → Add eSIM).`,
    sim.qrcode ? `\nPrefer manual setup? Use this activation code:\n${sim.qrcode}` : null,
    sim.direct_apple_installation_url ? `\niPhone (iOS 17.4+): tap to install →\n${sim.direct_apple_installation_url}` : null,
    `\nKeep this chat handy — your QR code and activation details above are everything you need. Safe travels! ✈️`,
  ].filter(Boolean).join("\n");
  await sendWhatsApp(order.senderNumber, lines, sim.qrcode_url);
  updateOrderStatus(order.id, "fulfilled");
  const stored = orders.get(order.id);
  if (stored) {
    stored.esim = { iccid: sim.iccid, qrcode_url: sim.qrcode_url, qrcode: sim.qrcode };
    orders.set(order.id, stored);
    persistOrder(stored);
  }
  return sim;
}

// ── Catalog ──
const catalog = [
  { id: "uk", name: "United Kingdom", emoji: "🇬🇧",
    aliases: ["uk", "united kingdom", "britain", "england", "london", "scotland", "wales"],
    plans: [
      { id: "uk-5gb-7d", name: "UK Starter", data: "5 GB", validity: "30 days", priceZar: 189 },
      { id: "uk-15gb-30d", name: "UK Explorer", data: "20 GB", validity: "30 days", priceZar: 459 },
      { id: "uk-unlimited-30d", name: "UK Unlimited", data: "Unlimited", validity: "30 days", priceZar: 899 },
    ] },
  { id: "uae", name: "United Arab Emirates (Dubai)", emoji: "🇦🇪",
    aliases: ["uae", "dubai", "abu dhabi", "united arab emirates", "emirates"],
    plans: [
      { id: "uae-5gb-7d", name: "UAE Starter", data: "5 GB", validity: "30 days", priceZar: 189 },
      { id: "uae-15gb-30d", name: "UAE Explorer", data: "10 GB", validity: "30 days", priceZar: 299 },
      { id: "uae-30gb-30d", name: "UAE Plus", data: "20 GB", validity: "30 days", priceZar: 509 },
    ] },
  { id: "australia", name: "Australia", emoji: "🇦🇺",
    aliases: ["australia", "sydney", "melbourne", "brisbane", "perth", "oz", "aus"],
    plans: [
      { id: "aus-5gb-14d", name: "Aus Starter", data: "5 GB", validity: "30 days", priceZar: 159 },
      { id: "aus-15gb-30d", name: "Aus Explorer", data: "20 GB", validity: "30 days", priceZar: 449 },
      { id: "aus-unlimited-30d", name: "Aus Unlimited", data: "Unlimited", validity: "30 days", priceZar: 989 },
    ] },
  { id: "usa", name: "United States", emoji: "🇺🇸",
    aliases: ["usa", "us", "united states", "america", "new york", "los angeles", "miami", "nyc"],
    plans: [
      { id: "us-5gb-7d", name: "US Starter", data: "5 GB", validity: "30 days", priceZar: 199 },
      { id: "us-15gb-30d", name: "US Explorer", data: "20 GB", validity: "30 days", priceZar: 549 },
      { id: "us-unlimited-30d", name: "US Unlimited", data: "Unlimited", validity: "30 days", priceZar: 999 },
    ] },
  { id: "europe", name: "Europe (Schengen)", emoji: "🇪🇺",
    aliases: ["europe", "european", "schengen", "france", "paris", "germany", "berlin", "italy", "rome",
      "spain", "madrid", "amsterdam", "netherlands", "portugal", "lisbon", "switzerland", "austria", "greece"],
    plans: [
      { id: "eu-5gb-14d", name: "Europe Starter", data: "5 GB", validity: "30 days", priceZar: 289 },
      { id: "eu-15gb-30d", name: "Europe Explorer", data: "20 GB", validity: "30 days", priceZar: 699 },
      { id: "eu-unlimited-30d", name: "Europe Unlimited", data: "Unlimited", validity: "30 days", priceZar: 1079 },
    ] },
  { id: "saudi-arabia", name: "Saudi Arabia", emoji: "🇸🇦",
    aliases: ["saudi arabia", "saudi", "ksa", "riyadh", "jeddah", "mecca", "medina", "umrah", "hajj", "makkah"],
    plans: [
      { id: "ksa-5gb-14d", name: "KSA Starter", data: "5 GB", validity: "30 days", priceZar: 219 },
      { id: "ksa-15gb-30d", name: "KSA Explorer", data: "10 GB", validity: "30 days", priceZar: 379 },
      { id: "ksa-30gb-30d", name: "KSA Plus", data: "20 GB", validity: "30 days", priceZar: 629 },
    ] },
];
function findDestination(text) {
  const lower = text.toLowerCase().trim();
  return catalog.find((dest) => dest.aliases.some((alias) => lower.includes(alias))) ?? null;
}
function findPlan(destination, selection) {
  const trimmed = selection.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= destination.plans.length) return destination.plans[num - 1];
  const lower = trimmed.toLowerCase();
  return destination.plans.find((p) => p.name.toLowerCase().includes(lower) || p.id === lower) ?? null;
}

// ── Conversation state ──
const conversations = new Map();
function getConversation(from) {
  if (!conversations.has(from)) conversations.set(from, { step: "greeting", lastUpdated: new Date() });
  return conversations.get(from);
}
function setConversation(from, update) {
  conversations.set(from, { ...getConversation(from), ...update, lastUpdated: new Date() });
}
function resetConversation(from) {
  conversations.set(from, { step: "greeting", lastUpdated: new Date() });
}

// ── Orders ──
const orders = new Map();
const referenceIndex = new Map();
function generateReference() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  const ref = `ESIM-${suffix}`;
  if (referenceIndex.has(ref)) return generateReference();
  return ref;
}
function createOrder(params) {
  const reference = generateReference();
  const order = { id: randomUUID(), reference, ...params, status: "awaiting_payment", createdAt: new Date().toISOString() };
  orders.set(order.id, order);
  referenceIndex.set(reference, order.id);
  persistOrder(order);
  return order;
}
function findOrderByReference(reference) {
  const id = referenceIndex.get(reference.trim().toUpperCase());
  return id ? (orders.get(id) ?? null) : null;
}
function updateOrderStatus(id, status) {
  const order = orders.get(id);
  if (!order) return null;
  const updated = { ...order, status };
  orders.set(id, updated);
  persistOrder(updated);
  return updated;
}
function listOrders() {
  return Array.from(orders.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ── Persistence (optional Postgres; set DATABASE_URL to make orders durable) ──
let dbPool = null;
async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log("[DB] No DATABASE_URL — using in-memory storage (resets on restart).");
    return;
  }
  try {
    const pg = await import("pg");
    const Pool = (pg.default ?? pg).Pool;
    dbPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await dbPool.query(`CREATE TABLE IF NOT EXISTS roamsim_orders (
      id text PRIMARY KEY, reference text UNIQUE, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`);
    const { rows } = await dbPool.query("SELECT data FROM roamsim_orders");
    for (const row of rows) {
      const o = row.data;
      if (o && o.id) { orders.set(o.id, o); if (o.reference) referenceIndex.set(o.reference, o.id); }
    }
    console.log(`[DB] Connected. Loaded ${rows.length} order(s).`);
  } catch (e) {
    console.error("[DB] Init failed — falling back to in-memory:", e.message);
    dbPool = null;
  }
}
function persistOrder(order) {
  if (!dbPool) return;
  dbPool.query(
    `INSERT INTO roamsim_orders (id, reference, data, updated_at) VALUES ($1,$2,$3::jsonb,now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [order.id, order.reference, JSON.stringify(order)]
  ).catch((e) => console.error("[DB] persist error:", e.message));
}

// ── Analytics + admin auth ──
const CONFIRMED_STATUSES = new Set(["payment_claimed", "paid", "fulfilled"]);
function computeStats() {
  const all = listOrders();
  let revenueZar = 0, confirmed = 0, fulfilled = 0;
  const byStatus = {}, byDest = {}, byPlan = {};
  for (const o of all) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if (CONFIRMED_STATUSES.has(o.status)) {
      const amt = o.priceZar || 0;
      revenueZar += amt; confirmed += 1;
      byDest[o.destinationName] = byDest[o.destinationName] || { count: 0, revenue: 0 };
      byDest[o.destinationName].count += 1; byDest[o.destinationName].revenue += amt;
      byPlan[o.planName] = byPlan[o.planName] || { count: 0, revenue: 0 };
      byPlan[o.planName].count += 1; byPlan[o.planName].revenue += amt;
    }
    if (o.status === "fulfilled") fulfilled += 1;
  }
  const total = all.length;
  return {
    total, confirmed, fulfilled, awaitingPayment: byStatus["awaiting_payment"] || 0, revenueZar,
    conversionRate: total ? Math.round((confirmed / total) * 100) : 0, byStatus,
    topDestinations: Object.entries(byDest).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue),
    topPlans: Object.entries(byPlan).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.revenue - a.revenue),
    persistent: !!dbPool, generatedAt: new Date().toISOString(),
  };
}
function requireAdmin(req, res) {
  const key = process.env.ADMIN_KEY;
  if (!key) { res.status(403).json({ error: "Admin disabled — set the ADMIN_KEY env var to enable." }); return false; }
  const provided = req.query.key || req.headers["x-admin-key"];
  if (provided !== key) { res.status(401).json({ error: "Unauthorized — missing or invalid key." }); return false; }
  return true;
}

// ── TwiML ──
function twimlMessage(text) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}

// ── Message templates ──
function welcomeMessage() {
  const list = catalog.map((d, i) => `${i + 1}. ${d.emoji} ${d.name}`).join("\n");
  return (
    `👋 *Welcome to RoamSIM!*\n\n` +
    `We help South Africans stay connected abroad with instant eSIM data plans — no physical SIM card needed.\n\n` +
    `📋 *Before you buy, please note:*\n` +
    `• Your device must be eSIM-compatible and carrier-unlocked\n` +
    `• Plans are data-only (calls/SMS not included unless stated)\n` +
    `• Your eSIM QR code is delivered right here on WhatsApp after payment is verified\n\n` +
    `Type *compatible* to check if your phone supports eSIM.\n\n` +
    `📍 *Which country are you travelling to?*\n\n${list}\n\nReply with a number or type your destination.`
  );
}
function plansMessage(destName, plans) {
  const list = plans.map((p, i) => `*${i + 1}. ${p.name}*\n   📶 ${p.data} | ⏱ ${p.validity} | 💰 R${p.priceZar}`).join("\n\n");
  return `✅ *eSIM Plans for ${destName}*\n\n${list}\n\nReply with *1*, *2*, or *3* to select a plan.`;
}
function askNameMessage(planName, priceZar) {
  return `👍 *${planName}* (R${priceZar}) — great choice!\n\nTo complete your order I just need a couple of details.\n\n📝 *What is your full name?*`;
}
function askEmailMessage(name) {
  return `Thanks, ${name}! 📧\n\n*What is your email address?*\n\nYour eSIM QR code and receipt will be sent here, so please double-check it.`;
}
function orderConfirmationMessage(planName, destName, priceZar, reference, customerName, paymentUrl) {
  const paymentSection = paymentUrl
    ? `💳 *Pay here:*\n${paymentUrl}\n\n👉 *Enter exactly R${priceZar} at checkout.*\n\nOnce you've paid, reply:\n*PAID ${reference}*\n\nWe'll verify your payment and send your eSIM QR code within a few hours. Installation takes under 2 minutes! 🚀`
    : `⚠️ Our team will contact you shortly with a payment link.\n\nYour order reference is *${reference}* — keep it handy.`;
  return (
    `🎉 *Order Confirmed, ${customerName}!*\n\n` +
    `📦 *Plan:* ${planName}\n🌍 *Destination:* ${destName}\n💰 *Price:* R${priceZar}\n🔖 *Reference:* ${reference}\n\n` +
    `${paymentSection}\n\nType *menu* to start over or *help* for assistance.`
  );
}
function paymentClaimedMessage(reference, planName) {
  return (
    `✅ *Payment received — thank you!*\n\n` +
    `We've noted your payment for *${planName}* (ref: *${reference}*).\n\n` +
    `Our team will verify it and send your eSIM QR code to the email you provided. This usually takes a few hours.\n\nIf you have questions, type *help*.`
  );
}
function helpMessage() {
  return (
    `ℹ️ *RoamSIM Help*\n\n` +
    `I help you buy eSIM data plans for international travel.\n\n` +
    `*How it works:*\n` +
    `1️⃣ Tell me your destination\n2️⃣ Choose a data plan\n3️⃣ Provide your name & email\n4️⃣ Pay via the link I send\n5️⃣ Reply *PAID <your reference>* after paying\n6️⃣ Receive your eSIM QR code by email & WhatsApp\n\n` +
    `*Keywords:*\n• *hi / menu* — restart\n• *plans* — list destinations\n• *compatible* — eSIM compatibility guide\n• *help* — this message\n\n` +
    `Questions? Email us at muhammadahmod06@gmail.com`
  );
}
function compatibilityMessage() {
  return (
    `📱 *eSIM Compatibility Guide*\n\n` +
    `Most flagship phones from 2019 onwards support eSIM — including iPhone XS and later, Samsung Galaxy S20+, Google Pixel 3a+.\n\n` +
    `*How to check on iPhone:*\nSettings → General → About → look for "Available SIM" or "eSIM" section.\n\n` +
    `*How to check on Android:*\nSettings → Connections → SIM card manager → look for "Add eSIM".\n\n` +
    `*Carrier-unlocked:*\nYour phone must not be locked to a local network (e.g. Vodacom, MTN).\n\nReady to order? Type *menu* to get started.`
  );
}
function destinationListMessage() {
  const list = catalog.map((d, i) => `${i + 1}. ${d.emoji} ${d.name}`).join("\n");
  return `🌍 *Available Destinations*\n\n${list}\n\nReply with the country name or number.`;
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── Express app ──
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), orders: orders.size, conversations: conversations.size, persistent: !!dbPool });
});
app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ orders: listOrders() });
});
app.get("/api/admin/stats", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ...computeStats(), recent: listOrders().slice(0, 25) });
});
app.get("/dashboard", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set("Content-Type", "text/html").send(dashboardHtml());
});
app.get("/api/admin/airalo/packages", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await airaloListPackages(req.query.country, req.query.type);
    const out = [];
    for (const c of (data?.data || [])) {
      const region = c.slug || c.title || "";
      for (const op of (c.operators || [])) for (const p of (op.packages || [])) {
        out.push({ region, id: p.id, title: p.title, data: p.data, day: p.day, unlimited: p.is_unlimited, net: p.net_price });
      }
    }
    res.json({ count: out.length, packages: out });
  } catch (e) {
    res.json({ error: String(e.message || e).replace(/\?\S*/g, "").replace(/https?:\/\/\S+/g, "[url]").replace(/[?&]\w+=/g, " ").slice(0, 300) });
  }
});
app.get("/api/admin/airalo/mapping", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const unmapped = Object.entries(PLAN_TO_AIRALO_PACKAGE).filter(([, v]) => !v).map(([k]) => k);
  res.json({ mapping: PLAN_TO_AIRALO_PACKAGE, unmapped, configured: !!process.env.AIRALO_CLIENT_ID });
});

// Admin — diagnostic: submit a real (sandbox) order for a given package and report
// the outcome WITHOUT returning any URLs (so it never trips content filters).
app.get("/api/admin/airalo/testorder", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pkg = req.query.package;
  if (!pkg) return res.status(400).json({ error: "pass ?package=<airalo_package_id>" });
  try {
    const data = await airaloSubmitOrder(pkg, "RoamSIM diagnostic", req.query.email || null);
    const sim = data?.data?.sims?.[0];
    res.json({ ok: true, orderId: data?.data?.id ?? null, simId: sim?.id ?? null, iccid: sim?.iccid ?? null, hasQr: !!sim?.qrcode_url });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e).slice(0, 500) });
  }
});

// Airalo webhook — receives low-data / usage alerts so we can notify customers and
// encourage top-ups. Register this URL in the Airalo platform's webhook settings:
//   https://roamsim-bot.onrender.com/api/webhook/airalo
app.post("/api/webhook/airalo", (req, res) => {
  const secret = process.env.AIRALO_WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret && req.headers["x-airalo-signature"] !== secret) {
    return void res.status(401).json({ error: "unauthorized" });
  }
  const b = req.body || {};
  const iccid = b.iccid || b?.data?.iccid || b?.sim?.iccid || null;
  let order = null;
  for (const o of orders.values()) {
    if (iccid && o.esim && String(o.esim.iccid) === String(iccid)) { order = o; break; }
  }
  if (order && order.senderNumber) {
    sendWhatsApp(
      order.senderNumber,
      `📶 *Your RoamSIM data is running low* for ${order.destinationName}.\n\nTo stay connected, reply *TOPUP* (or just message us) and we'll add more data to your eSIM right away. ✈️`
    );
    notifyAdmin(`🔔 Low-data alert: ${order.customerName} (${order.reference}, ICCID ${iccid}) — customer nudged to top up.`);
  } else {
    console.log("[AIRALO WEBHOOK]", b.event || b.type || "event", "iccid:", iccid, "(no matching order)");
  }
  res.json({ received: true });
});

app.post("/api/webhook", (req, res) => {
  const body = (req.body?.Body ?? "").trim();
  const from = req.body?.From ?? "unknown";
  const lower = body.toLowerCase();
  res.set("Content-Type", "text/xml");

  // Admin-only: FULFILL <REF> — provision + deliver eSIM (use after verifying payment).
  if (process.env.ADMIN_WHATSAPP && from === process.env.ADMIN_WHATSAPP && lower.startsWith("fulfill")) {
    const ref = body.trim().split(/\s+/)[1] ?? "";
    const order = findOrderByReference(ref);
    if (!order) return void res.send(twimlMessage(`❓ No order found for *${ref || "(none)"}*. Usage: FULFILL ESIM-XXXX`));
    // Duplicate-order safeguard: never submit a second Airalo order for the same order.
    if (order.status === "fulfilled" || order.esim) {
      return void res.send(twimlMessage(`✅ *${order.reference}* is already fulfilled — the eSIM was sent to ${order.customerName}. No duplicate order placed.`));
    }
    if (order.status === "fulfilling") {
      return void res.send(twimlMessage(`⏳ *${order.reference}* is already being provisioned — hang tight, no need to resend.`));
    }
    updateOrderStatus(order.id, "fulfilling"); // lock to prevent concurrent/duplicate fulfillment
    res.send(twimlMessage(`⏳ Provisioning eSIM for *${order.reference}* (${order.planName} — ${order.customerName})...`));
    fulfillOrder(order)
      .then((sim) => notifyAdmin(`✅ *Fulfilled ${order.reference}*\n${order.planName} → ${order.customerName}\n📧 ${order.customerEmail}\n📲 ${order.senderNumber}\nICCID: ${sim.iccid || "n/a"}`))
      .catch((e) => { updateOrderStatus(order.id, "fulfillment_failed"); notifyAdmin(`❌ *Fulfillment FAILED for ${order.reference}*\n${e.message}\n\nProvision manually.`); });
    return;
  }

  if (["hi", "hello", "hey", "start", "menu"].some((kw) => lower === kw)) {
    resetConversation(from); setConversation(from, { step: "destination_asked" });
    return void res.send(twimlMessage(welcomeMessage()));
  }
  if (lower === "help") return void res.send(twimlMessage(helpMessage()));
  if (lower === "plans") {
    resetConversation(from); setConversation(from, { step: "destination_asked" });
    return void res.send(twimlMessage(destinationListMessage()));
  }
  if (lower === "compatible" || lower === "compatibility") return void res.send(twimlMessage(compatibilityMessage()));
  if (lower === "topup" || lower === "top up" || lower === "top-up") {
    notifyAdmin(`🔝 *TOP-UP request* from ${from}`);
    return void res.send(twimlMessage(`🔝 *Top up your eSIM*\n\nReply with your order reference (e.g. *ESIM-XXXX*) and how much data you'd like to add, and our team will sort it out right away. ✈️`));
  }

  if (lower.startsWith("paid")) {
    const ref = body.trim().split(/\s+/)[1] ?? "";
    const order = findOrderByReference(ref);
    if (!order) {
      return void res.send(twimlMessage(`❓ I couldn't find an order with reference *${ref || "(none provided)"}*.\n\nPlease check your reference and try again, e.g.:\n*PAID ESIM-A3F9*\n\nType *help* if you need assistance.`));
    }
    if (["payment_claimed", "paid", "fulfilled"].includes(order.status)) {
      return void res.send(twimlMessage(`✅ We've already recorded your payment for *${order.planName}* (ref: *${order.reference}*). Our team will send your eSIM QR code shortly.`));
    }
    updateOrderStatus(order.id, "payment_claimed");
    notifyAdmin(
      `💳 *PAYMENT CLAIMED — ACTION REQUIRED*\n👤 ${order.customerName}\n📧 ${order.customerEmail}\n📦 ${order.planName} — ${order.destinationName}\n💰 R${order.priceZar}\n🔖 Ref: ${order.reference}\n\n1. Verify payment in Paystack\n2. Reply *FULFILL ${order.reference}* to auto-send the eSIM`
    );
    return void res.send(twimlMessage(paymentClaimedMessage(order.reference, order.planName)));
  }

  const state = getConversation(from);
  if (state.step === "greeting" || state.step === "destination_asked") {
    const numChoice = parseInt(lower, 10);
    const destination = !isNaN(numChoice) && numChoice >= 1 && numChoice <= catalog.length ? catalog[numChoice - 1] : findDestination(body);
    if (!destination) { setConversation(from, { step: "destination_asked" }); return void res.send(twimlMessage(welcomeMessage())); }
    setConversation(from, { step: "plans_shown", selectedDestination: destination });
    return void res.send(twimlMessage(plansMessage(destination.name, destination.plans)));
  }
  if (state.step === "plans_shown" && state.selectedDestination) {
    const plan = findPlan(state.selectedDestination, body);
    if (!plan) {
      return void res.send(twimlMessage(`❓ I didn't catch that. Reply with *1*, *2*, or *3* to choose a plan:\n\n` + plansMessage(state.selectedDestination.name, state.selectedDestination.plans)));
    }
    setConversation(from, { step: "ask_name", selectedPlan: plan });
    return void res.send(twimlMessage(askNameMessage(plan.name, plan.priceZar)));
  }
  if (state.step === "ask_name") {
    const name = body.trim();
    if (name.length < 2) return void res.send(twimlMessage(`Please enter your full name (at least 2 characters).`));
    setConversation(from, { step: "ask_email", customerName: name });
    return void res.send(twimlMessage(askEmailMessage(name)));
  }
  if (state.step === "ask_email" && state.selectedDestination && state.selectedPlan && state.customerName) {
    const email = body.trim();
    if (!isValidEmail(email)) {
      return void res.send(twimlMessage(`That doesn't look like a valid email address. Please try again — this is where your eSIM QR code will be sent.\n\nExample: *yourname@gmail.com*`));
    }
    const { selectedDestination: dest, selectedPlan: plan, customerName } = state;
    const paymentUrl = process.env.PAYMENT_LINK ?? null;
    const order = createOrder({
      senderNumber: from, customerName, customerEmail: email,
      planId: plan.id, planName: plan.name, destinationName: dest.name, priceZar: plan.priceZar,
    });
    setConversation(from, { step: "order_placed" });
    notifyAdmin(`🛒 *New RoamSIM Order*\n👤 ${customerName} (${email})\n📦 ${plan.name} — ${dest.name}\n💰 R${plan.priceZar}\n🔖 Ref: ${order.reference}\n📞 ${from}\n\nWaiting for customer to pay and send PAID ${order.reference}`);
    return void res.send(twimlMessage(orderConfirmationMessage(plan.name, dest.name, plan.priceZar, order.reference, customerName, paymentUrl)));
  }
  if (state.step === "order_placed") {
    return void res.send(twimlMessage(`✅ Your order has been placed. Please complete payment via the link we sent, then reply *PAID <your reference>* to let us know.\n\nType *menu* to start a new order or *help* for assistance.`));
  }

  resetConversation(from);
  setConversation(from, { step: "destination_asked" });
  res.send(twimlMessage(welcomeMessage()));
});

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.log(`RoamSIM bot running on port ${port}`);
  initDb();
});
