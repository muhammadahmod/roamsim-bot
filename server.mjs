/**
 * RoamSIM WhatsApp Bot — server.mjs
 * Single-file Express server. No build step required.
 *
 * Environment variables:
 *   PORT                 — port to listen on (Render sets this automatically)
 *   PAYMENT_LINK         — Paystack payment URL sent in order confirmations
 *   TWILIO_ACCOUNT_SID   — Twilio account SID (for admin notifications)
 *   TWILIO_AUTH_TOKEN    — Twilio auth token (for admin notifications)
 *   TWILIO_FROM          — Twilio WhatsApp sender, e.g. whatsapp:+27XXXXXXXXX
 *   ADMIN_WHATSAPP       — your WhatsApp number to receive alerts, e.g. whatsapp:+27XXXXXXXXX
 */
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import https from "https";
// ─────────────────────────────────────────────────────────────────────────────
// ADMIN NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
// Send a WhatsApp message (optionally with a media attachment) via Twilio.
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
  if (!to) {
    console.log("[ADMIN NOTIFY - not configured]", message);
    return Promise.resolve();
  }
  return sendWhatsApp(to, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// AIRALO PARTNER API (eSIM auto-provisioning)
//   Env: AIRALO_CLIENT_ID, AIRALO_CLIENT_SECRET, AIRALO_BASE_URL
//   Default base is the sandbox; set AIRALO_BASE_URL to the production host
//   (https://partners-api.airalo.com) when ready to sell real eSIMs.
// ─────────────────────────────────────────────────────────────────────────────
const AIRALO_BASE = process.env.AIRALO_BASE_URL || "https://sandbox-partners-api.airalo.com";

// Map each catalog plan id -> Airalo package_id (slug).
// Populate these from GET /api/admin/airalo/packages after credentials are set.
// An empty value means "not yet mapped" and fulfillment will report it clearly.
const PLAN_TO_AIRALO_PACKAGE = {
  "uk-5gb-7d": "",        "uk-15gb-30d": "",       "uk-unlimited-30d": "",
  "uae-5gb-7d": "",       "uae-15gb-30d": "",      "uae-30gb-30d": "",
  "aus-5gb-14d": "",      "aus-15gb-30d": "",      "aus-unlimited-30d": "",
  "us-5gb-7d": "",        "us-15gb-30d": "",       "us-unlimited-30d": "",
  "eu-5gb-14d": "",       "eu-15gb-30d": "",       "eu-unlimited-30d": "",
  "ksa-5gb-14d": "",      "ksa-15gb-30d": "",      "ksa-30gb-30d": "",
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
        if (res.statusCode >= 400) {
          return reject(new Error(`Airalo ${method} ${path} -> ${res.statusCode}: ${data.slice(0, 300)}`));
        }
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
  if (!id || !secret) throw new Error("Airalo credentials not configured (set AIRALO_CLIENT_ID / AIRALO_CLIENT_SECRET)");
  if (airaloTokenCache.token && Date.now() < airaloTokenCache.expiresAt) return airaloTokenCache.token;
  const res = await airaloHttp("POST", "/v2/token", {
    form: { client_id: id, client_secret: secret, grant_type: "client_credentials" },
  });
  const token = res?.data?.access_token;
  if (!token) throw new Error("Airalo token missing in response");
  const ttlMs = (res?.data?.expires_in || 86400) * 1000;
  airaloTokenCache = { token, expiresAt: Date.now() + ttlMs - 60000 };
  return token;
}

async function airaloListPackages(country) {
  const token = await getAiraloToken();
  const q = country ? `?filter[country]=${encodeURIComponent(country)}&limit=100` : "?limit=100";
  return airaloHttp("GET", "/v2/packages" + q, { token });
}

async function airaloSubmitOrder(packageId, description, toEmail) {
  const token = await getAiraloToken();
  const form = { package_id: packageId, quantity: 1, type: "sim", description: description || "RoamSIM order" };
  if (toEmail) form.to_email = toEmail; // Airalo emails the customer a white-label install guide.
  return airaloHttp("POST", "/v2/orders", { token, form });
}

// Provision an eSIM for a paid order and deliver the QR to the customer.
async function fulfillOrder(order) {
  const packageId = PLAN_TO_AIRALO_PACKAGE[order.planId];
  if (!packageId) throw new Error(`No Airalo package mapped for plan "${order.planId}" — update PLAN_TO_AIRALO_PACKAGE`);
  const res = await airaloSubmitOrder(packageId, order.reference, order.customerEmail);
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
    `\nWe've also emailed full instructions to ${order.customerEmail}. Safe travels! ✈️`,
  ].filter(Boolean).join("\n");
  await sendWhatsApp(order.senderNumber, lines, sim.qrcode_url);
  updateOrderStatus(order.id, "fulfilled");
  const stored = orders.get(order.id);
  if (stored) {
    stored.esim = { iccid: sim.iccid, qrcode_url: sim.qrcode_url, qrcode: sim.qrcode };
    orders.set(order.id, stored);
  }
  return sim;
}
// ─────────────────────────────────────────────────────────────────────────────
// CATALOG
// ─────────────────────────────────────────────────────────────────────────────
const catalog = [
  {
    id: "uk",
    name: "United Kingdom",
    emoji: "🇬🇧",
    aliases: ["uk", "united kingdom", "britain", "england", "london", "scotland", "wales"],
    plans: [
      { id: "uk-5gb-7d",       name: "UK Starter",   data: "5 GB",      validity: "7 days",  priceZar: 249 },
      { id: "uk-15gb-30d",     name: "UK Explorer",  data: "15 GB",     validity: "30 days", priceZar: 549 },
      { id: "uk-unlimited-30d", name: "UK Unlimited", data: "Unlimited", validity: "30 days", priceZar: 899 },
    ],
  },
  {
    id: "uae",
    name: "United Arab Emirates (Dubai)",
    emoji: "🇦🇪",
    aliases: ["uae", "dubai", "abu dhabi", "united arab emirates", "emirates"],
    plans: [
      { id: "uae-5gb-7d",   name: "UAE Starter",  data: "5 GB",  validity: "7 days",  priceZar: 229 },
      { id: "uae-15gb-30d", name: "UAE Explorer", data: "15 GB", validity: "30 days", priceZar: 499 },
      { id: "uae-30gb-30d", name: "UAE Plus",     data: "30 GB", validity: "30 days", priceZar: 799 },
    ],
  },
  {
    id: "australia",
    name: "Australia",
    emoji: "🇦🇺",
    aliases: ["australia", "sydney", "melbourne", "brisbane", "perth", "oz", "aus"],
    plans: [
      { id: "aus-5gb-14d",       name: "Aus Starter",   data: "5 GB",      validity: "14 days", priceZar: 299 },
      { id: "aus-15gb-30d",      name: "Aus Explorer",  data: "15 GB",     validity: "30 days", priceZar: 599 },
      { id: "aus-unlimited-30d", name: "Aus Unlimited", data: "Unlimited", validity: "30 days", priceZar: 999 },
    ],
  },
  {
    id: "usa",
    name: "United States",
    emoji: "🇺🇸",
    aliases: ["usa", "us", "united states", "america", "new york", "los angeles", "miami", "nyc"],
    plans: [
      { id: "us-5gb-7d",        name: "US Starter",   data: "5 GB",      validity: "7 days",  priceZar: 279 },
      { id: "us-15gb-30d",      name: "US Explorer",  data: "15 GB",     validity: "30 days", priceZar: 599 },
      { id: "us-unlimited-30d", name: "US Unlimited", data: "Unlimited", validity: "30 days", priceZar: 999 },
    ],
  },
  {
    id: "europe",
    name: "Europe (Schengen)",
    emoji: "🇪🇺",
    aliases: [
      "europe", "european", "schengen", "france", "paris", "germany", "berlin",
      "italy", "rome", "spain", "madrid", "amsterdam", "netherlands", "portugal",
      "lisbon", "switzerland", "austria", "greece",
    ],
    plans: [
      { id: "eu-5gb-14d",       name: "Europe Starter",   data: "5 GB",      validity: "14 days", priceZar: 349 },
      { id: "eu-15gb-30d",      name: "Europe Explorer",  data: "15 GB",     validity: "30 days", priceZar: 699 },
      { id: "eu-unlimited-30d", name: "Europe Unlimited", data: "Unlimited", validity: "30 days", priceZar: 1099 },
    ],
  },
  {
    id: "saudi-arabia",
    name: "Saudi Arabia",
    emoji: "🇸🇦",
    aliases: ["saudi arabia", "saudi", "ksa", "riyadh", "jeddah", "mecca", "medina", "umrah", "hajj", "makkah"],
    plans: [
      { id: "ksa-5gb-14d",  name: "KSA Starter",  data: "5 GB",  validity: "14 days", priceZar: 259 },
      { id: "ksa-15gb-30d", name: "KSA Explorer", data: "15 GB", validity: "30 days", priceZar: 549 },
      { id: "ksa-30gb-30d", name: "KSA Plus",     data: "30 GB", validity: "30 days", priceZar: 849 },
    ],
  },
];
function findDestination(text) {
  const lower = text.toLowerCase().trim();
  return catalog.find((dest) => dest.aliases.some((alias) => lower.includes(alias))) ?? null;
}
function findPlan(destination, selection) {
  const trimmed = selection.trim();
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= destination.plans.length) {
    return destination.plans[num - 1];
  }
  const lower = trimmed.toLowerCase();
  return destination.plans.find((p) => p.name.toLowerCase().includes(lower) || p.id === lower) ?? null;
}
// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION STATE
// ─────────────────────────────────────────────────────────────────────────────
const conversations = new Map();
function getConversation(from) {
  if (!conversations.has(from)) {
    conversations.set(from, { step: "greeting", lastUpdated: new Date() });
  }
  return conversations.get(from);
}
function setConversation(from, update) {
  conversations.set(from, { ...getConversation(from), ...update, lastUpdated: new Date() });
}
function resetConversation(from) {
  conversations.set(from, { step: "greeting", lastUpdated: new Date() });
}
// ─────────────────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────────────────
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
  const order = {
    id: randomUUID(),
    reference,
    ...params,
    status: "awaiting_payment",
    createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  referenceIndex.set(reference, order.id);
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
  return updated;
}
function listOrders() {
  return Array.from(orders.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}
// ─────────────────────────────────────────────────────────────────────────────
// TWIML
// ─────────────────────────────────────────────────────────────────────────────
function twimlMessage(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}
// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────
function welcomeMessage() {
  const list = catalog.map((d, i) => `${i + 1}. ${d.emoji} ${d.name}`).join("\n");
  return (
    `👋 *Welcome to RoamSIM!*\n\n` +
    `We help South Africans stay connected abroad with instant eSIM data plans — no physical SIM card needed.\n\n` +
    `📋 *Before you buy, please note:*\n` +
    `• Your device must be eSIM-compatible and carrier-unlocked\n` +
    `• Plans are data-only (calls/SMS not included unless stated)\n` +
    `• Your eSIM QR code is delivered by email and WhatsApp after payment is verified\n\n` +
    `Type *compatible* to check if your phone supports eSIM.\n\n` +
    `📍 *Which country are you travelling to?*\n\n${list}\n\nReply with a number or type your destination.`
  );
}
function plansMessage(destName, plans) {
  const list = plans
    .map((p, i) => `*${i + 1}. ${p.name}*\n   📶 ${p.data} | ⏱ ${p.validity} | 💰 R${p.priceZar}`)
    .join("\n\n");
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
// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    orders: orders.size,
    conversations: conversations.size,
  });
});
// Admin — list orders
app.get("/api/admin/orders", (_req, res) => {
  res.json({ orders: listOrders() });
});

// Admin — list available Airalo packages (used to build PLAN_TO_AIRALO_PACKAGE).
// Optional ?country=GB|AE|US|... filter. Returns Airalo's catalog only (no secrets).
app.get("/api/admin/airalo/packages", async (req, res) => {
  try {
    const data = await airaloListPackages(req.query.country);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin — show current plan -> Airalo package mapping and which are unmapped.
app.get("/api/admin/airalo/mapping", (_req, res) => {
  const unmapped = Object.entries(PLAN_TO_AIRALO_PACKAGE)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  res.json({ mapping: PLAN_TO_AIRALO_PACKAGE, unmapped, configured: !!process.env.AIRALO_CLIENT_ID });
});
// WhatsApp webhook
app.post("/api/webhook", (req, res) => {
  const body = (req.body?.Body ?? "").trim();
  const from = req.body?.From ?? "unknown";
  const lower = body.toLowerCase();
  res.set("Content-Type", "text/xml");
  // ── Admin-only command: FULFILL <REF> (provision + deliver eSIM via Airalo) ──
  // Gated to the operator's own WhatsApp number. Send this only after you have
  // verified the customer's payment in Paystack.
  if (process.env.ADMIN_WHATSAPP && from === process.env.ADMIN_WHATSAPP && lower.startsWith("fulfill")) {
    const ref = body.trim().split(/\s+/)[1] ?? "";
    const order = findOrderByReference(ref);
    if (!order) {
      return void res.send(twimlMessage(`❓ No order found for *${ref || "(none)"}*. Usage: FULFILL ESIM-XXXX`));
    }
    // Acknowledge immediately, then provision asynchronously (Airalo can take a few seconds).
    res.send(twimlMessage(`⏳ Provisioning eSIM for *${order.reference}* (${order.planName} — ${order.customerName})...`));
    fulfillOrder(order)
      .then((sim) =>
        notifyAdmin(
          `✅ *Fulfilled ${order.reference}*\n` +
          `${order.planName} sent to ${order.customerName}\n📧 ${order.customerEmail}\n📲 ${order.senderNumber}\n` +
          `ICCID: ${sim.iccid || "n/a"}`
        )
      )
      .catch((e) => {
        updateOrderStatus(order.id, "fulfillment_failed");
        notifyAdmin(`❌ *Fulfillment FAILED for ${order.reference}*\n${e.message}\n\nProvision this one manually.`);
      });
    return;
  }
  // Global keywords
  if (["hi", "hello", "hey", "start", "menu"].some((kw) => lower === kw)) {
    resetConversation(from);
    setConversation(from, { step: "destination_asked" });
    return void res.send(twimlMessage(welcomeMessage()));
  }
  if (lower === "help") return void res.send(twimlMessage(helpMessage()));
  if (lower === "plans") {
    resetConversation(from);
    setConversation(from, { step: "destination_asked" });
    return void res.send(twimlMessage(destinationListMessage()));
  }
  if (lower === "compatible" || lower === "compatibility") {
    return void res.send(twimlMessage(compatibilityMessage()));
  }
  // PAID <REF>
  if (lower.startsWith("paid")) {
    const ref = body.trim().split(/\s+/)[1] ?? "";
    const order = findOrderByReference(ref);
    if (!order) {
      return void res.send(
        twimlMessage(
          `❓ I couldn't find an order with reference *${ref || "(none provided)"}*.\n\nPlease check your reference and try again, e.g.:\n*PAID ESIM-A3F9*\n\nType *help* if you need assistance.`
        )
      );
    }
    if (order.status === "payment_claimed" || order.status === "paid") {
      return void res.send(
        twimlMessage(
          `✅ We've already recorded your payment for *${order.planName}* (ref: *${order.reference}*). Our team will send your eSIM QR code shortly.`
        )
      );
    }
    updateOrderStatus(order.id, "payment_claimed");
    // Urgent admin alert — action required
    notifyAdmin(
      `💳 *PAYMENT CLAIMED — ACTION REQUIRED*\n` +
      `👤 ${order.customerName}\n` +
      `📧 ${order.customerEmail}\n` +
      `📦 ${order.planName} — ${order.destinationName}\n` +
      `💰 R${order.priceZar}\n` +
      `🔖 Ref: ${order.reference}\n\n` +
      `1. Verify payment in Paystack\n` +
      `2. Provision eSIM from your provider\n` +
      `3. Send QR code to customer`
    );
    return void res.send(twimlMessage(paymentClaimedMessage(order.reference, order.planName)));
  }
  // Conversation flow
  const state = getConversation(from);
  if (state.step === "greeting" || state.step === "destination_asked") {
    const numChoice = parseInt(lower, 10);
    const destination =
      !isNaN(numChoice) && numChoice >= 1 && numChoice <= catalog.length
        ? catalog[numChoice - 1]
        : findDestination(body);
    if (!destination) {
      setConversation(from, { step: "destination_asked" });
      return void res.send(twimlMessage(welcomeMessage()));
    }
    setConversation(from, { step: "plans_shown", selectedDestination: destination });
    return void res.send(twimlMessage(plansMessage(destination.name, destination.plans)));
  }
  if (state.step === "plans_shown" && state.selectedDestination) {
    const plan = findPlan(state.selectedDestination, body);
    if (!plan) {
      return void res.send(
        twimlMessage(
          `❓ I didn't catch that. Reply with *1*, *2*, or *3* to choose a plan:\n\n` +
            plansMessage(state.selectedDestination.name, state.selectedDestination.plans)
        )
      );
    }
    setConversation(from, { step: "ask_name", selectedPlan: plan });
    return void res.send(twimlMessage(askNameMessage(plan.name, plan.priceZar)));
  }
  if (state.step === "ask_name") {
    const name = body.trim();
    if (name.length < 2) {
      return void res.send(twimlMessage(`Please enter your full name (at least 2 characters).`));
    }
    setConversation(from, { step: "ask_email", customerName: name });
    return void res.send(twimlMessage(askEmailMessage(name)));
  }
  if (
    state.step === "ask_email" &&
    state.selectedDestination &&
    state.selectedPlan &&
    state.customerName
  ) {
    const email = body.trim();
    if (!isValidEmail(email)) {
      return void res.send(
        twimlMessage(
          `That doesn't look like a valid email address. Please try again — this is where your eSIM QR code will be sent.\n\nExample: *yourname@gmail.com*`
        )
      );
    }
    const { selectedDestination: dest, selectedPlan: plan, customerName } = state;
    const paymentUrl = process.env.PAYMENT_LINK ?? null;
    const order = createOrder({
      senderNumber: from,
      customerName,
      customerEmail: email,
      planId: plan.id,
      planName: plan.name,
      destinationName: dest.name,
      priceZar: plan.priceZar,
    });
    setConversation(from, { step: "order_placed" });
    // Notify admin of new order
    notifyAdmin(
      `🛒 *New RoamSIM Order*\n` +
      `👤 ${customerName} (${email})\n` +
      `📦 ${plan.name} — ${dest.name}\n` +
      `💰 R${plan.priceZar}\n` +
      `🔖 Ref: ${order.reference}\n` +
      `📞 ${from}\n\n` +
      `Waiting for customer to pay and send PAID ${order.reference}`
    );
    return void res.send(
      twimlMessage(
        orderConfirmationMessage(
          plan.name,
          dest.name,
          plan.priceZar,
          order.reference,
          customerName,
          paymentUrl
        )
      )
    );
  }
  if (state.step === "order_placed") {
    return void res.send(
      twimlMessage(
        `✅ Your order has been placed. Please complete payment via the link we sent, then reply *PAID <your reference>* to let us know.\n\nType *menu* to start a new order or *help* for assistance.`
      )
    );
  }
  // Fallback
  resetConversation(from);
  setConversation(from, { step: "destination_asked" });
  res.send(twimlMessage(welcomeMessage()));
});
// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => console.log(`RoamSIM bot running on port ${port}`));
