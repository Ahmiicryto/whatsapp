/**
 * WA Commerce QR gateway: WhatsApp Web sessions (scan a QR code with the phone's WhatsApp).
 *
 * Unofficial (Baileys). WhatsApp may restrict numbers used for bulk or unsolicited messages;
 * prefer the official Cloud API for marketing. Runs on an always-on host (e.g. Render), not Vercel.
 *
 * Env: PORT, GATEWAY_SECRET (shared with the main app), APP_WEBHOOK_URL (https://YOUR-APP/webhooks/gateway),
 *      DATABASE_URL (+ DATABASE_SSL=true for hosted Postgres) — login data is stored there so restarts don't log out.
 */
import crypto from "node:crypto";
import express from "express";
import pg from "pg";
import pino from "pino";
import QRCode from "qrcode";
import {
  makeWASocket,
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  initAuthCreds,
  proto,
} from "@whiskeysockets/baileys";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const SECRET = process.env.GATEWAY_SECRET;
const WEBHOOK = process.env.APP_WEBHOOK_URL;
if (!SECRET || !WEBHOOK || !process.env.DATABASE_URL) {
  log.error("GATEWAY_SECRET, APP_WEBHOOK_URL and DATABASE_URL are required");
  process.exit(1);
}

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 5,
});
await db.query(`CREATE TABLE IF NOT EXISTS gateway_auth (session text NOT NULL, key text NOT NULL, value text NOT NULL, PRIMARY KEY (session, key))`);

// ---------------------------------------------------------------- auth state in Postgres

async function pgAuthState(session) {
  const read = async (key) => {
    const { rows } = await db.query(`SELECT value FROM gateway_auth WHERE session=$1 AND key=$2`, [session, key]);
    return rows[0] ? JSON.parse(rows[0].value, BufferJSON.reviver) : null;
  };
  const write = (key, data) =>
    db.query(
      `INSERT INTO gateway_auth (session, key, value) VALUES ($1,$2,$3) ON CONFLICT (session, key) DO UPDATE SET value=EXCLUDED.value`,
      [session, key, JSON.stringify(data, BufferJSON.replacer)]
    );
  const remove = (key) => db.query(`DELETE FROM gateway_auth WHERE session=$1 AND key=$2`, [session, key]);
  const creds = (await read("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          for (const id of ids) {
            let value = await read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              await (value ? write(`${category}-${id}`, value) : remove(`${category}-${id}`));
            }
          }
        },
      },
    },
    saveCreds: () => write("creds", creds),
    clear: () => db.query(`DELETE FROM gateway_auth WHERE session=$1`, [session]),
  };
}

// ---------------------------------------------------------------- events to the main app

async function emit(events) {
  const body = JSON.stringify({ events });
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json", "X-Gateway-Signature": sig }, body });
      if (res.ok) return;
      log.warn({ status: res.status }, "webhook rejected");
    } catch (err) {
      log.warn({ err: err.message }, "webhook failed");
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
}

// ---------------------------------------------------------------- sessions

const sessions = new Map(); // id -> { sock, status, qr, phone, name, queue }
const STATUS = { 2: "sent", 3: "delivered", 4: "read", 5: "read" };

function publicState(id) {
  const s = sessions.get(id);
  if (!s) return { status: "not_started" };
  return { status: s.status, qr: s.status === "qr" ? s.qr : undefined, phone: s.phone, name: s.name };
}

async function start(id) {
  const existing = sessions.get(id);
  if (existing && ["connected", "qr", "connecting"].includes(existing.status)) return publicState(id);
  const { state, saveCreds, clear } = await pgAuthState(id);
  const entry = existing || { status: "connecting", queue: Promise.resolve() };
  entry.status = "connecting";
  sessions.set(id, entry);

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
    logger: log.child({ session: id, level: "warn" }),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  entry.sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      entry.status = "qr";
      entry.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    }
    if (connection === "open") {
      entry.status = "connected";
      entry.qr = null;
      entry.phone = `+${String(sock.user?.id || "").split(":")[0].split("@")[0]}`;
      entry.name = sock.user?.name || null;
      log.info({ session: id, phone: entry.phone }, "connected");
      emit([{ type: "connection", session: id, status: "connected", phone: entry.phone, name: entry.name }]);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        entry.status = "logged_out";
        await clear();
        emit([{ type: "connection", session: id, status: "logged_out" }]);
      } else {
        entry.status = "connecting";
        setTimeout(() => start(id).catch((err) => log.error({ err: err.message }, "reconnect failed")), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const events = [];
    for (const m of messages) {
      const jid = m.key.remoteJid || "";
      if (m.key.fromMe || !jid.endsWith("@s.whatsapp.net")) continue; // skip groups, status, own messages
      const msg = m.message || {};
      const ev = {
        type: "message",
        session: id,
        from: jid.split("@")[0],
        wamid: m.key.id,
        timestamp: Number(m.messageTimestamp || 0) * 1000 || Date.now(),
        profileName: m.pushName || null,
        kind: "text",
        text: msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || "",
      };
      if (msg.buttonsResponseMessage) ev.text = msg.buttonsResponseMessage.selectedDisplayText || ev.text;
      if (msg.locationMessage) {
        const l = msg.locationMessage;
        ev.kind = "location";
        ev.location = { lat: l.degreesLatitude, lng: l.degreesLongitude, name: l.name || null, address: l.address || null };
      } else if (msg.audioMessage) {
        ev.kind = "audio";
        try {
          const buf = await downloadMediaMessage(m, "buffer", {});
          if (buf.length < 5 * 1024 * 1024) ev.media = { base64: buf.toString("base64"), mime: msg.audioMessage.mimetype };
        } catch (err) {
          log.warn({ err: err.message }, "audio download failed");
        }
      } else if (msg.imageMessage) {
        ev.kind = "image";
      }
      events.push(ev);
    }
    if (events.length) emit(events);
  });

  sock.ev.on("messages.update", (updates) => {
    const events = updates
      .filter((u) => u.key.fromMe && STATUS[u.update?.status])
      .map((u) => ({ type: "status", session: id, wamid: u.key.id, status: STATUS[u.update.status] }));
    if (events.length) emit(events);
  });

  return publicState(id);
}

/** Sends one message; sends from the same number are spaced out to look less like a bot. */
function send(id, to, body) {
  const s = sessions.get(id);
  if (!s || s.status !== "connected") {
    const err = new Error("WhatsApp is not connected. Scan the QR code again.");
    err.status = 409;
    throw err;
  }
  const jid = `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
  const media = (m) => (m.base64 ? Buffer.from(m.base64, "base64") : { url: m.link });
  let content;
  if (body.image) content = { image: media(body.image), caption: body.caption || "" };
  else if (body.document) {
    content = { document: media(body.document), mimetype: body.document.mime || "application/pdf", fileName: body.document.filename || "file.pdf", caption: body.caption || "" };
  } else content = { text: String(body.text || "") };

  const run = s.queue.then(async () => {
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 1200));
    const sent = await s.sock.sendMessage(jid, content);
    return sent.key.id;
  });
  s.queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- HTTP API (called by the main app)

const app = express();
app.use(express.json({ limit: "20mb" }));
app.get("/healthz", (_req, res) => res.json({ ok: true, sessions: sessions.size }));
app.use((req, res, next) => {
  const token = String(req.get("authorization") || "").replace(/^Bearer /, "");
  const a = Buffer.from(token);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "unauthorized" });
  next();
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    log.error({ err: err.message }, "request failed");
    res.status(err.status || 500).json({ error: err.message });
  });

app.post("/sessions/:id/start", wrap(async (req, res) => {
  const state = await start(req.params.id);
  // give the socket a moment to produce the first QR code
  for (let i = 0; i < 20 && sessions.get(req.params.id)?.status === "connecting"; i++) await new Promise((r) => setTimeout(r, 250));
  res.json({ ...state, ...publicState(req.params.id) });
}));
app.get("/sessions/:id", wrap(async (req, res) => res.json(publicState(req.params.id))));
app.post("/sessions/:id/send", wrap(async (req, res) => res.json({ id: await send(req.params.id, req.body.to, req.body) })));
app.delete("/sessions/:id", wrap(async (req, res) => {
  const s = sessions.get(req.params.id);
  try {
    await s?.sock?.logout();
  } catch {
    /* already closed */
  }
  sessions.delete(req.params.id);
  await db.query(`DELETE FROM gateway_auth WHERE session=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// resume every session that has saved login data
const { rows } = await db.query(`SELECT DISTINCT session FROM gateway_auth WHERE key='creds'`);
for (const r of rows) start(r.session).catch((err) => log.error({ err: err.message, session: r.session }, "resume failed"));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => log.info({ port, resumed: rows.length }, "gateway listening"));
