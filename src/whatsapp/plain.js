/**
 * QR-linked (WhatsApp Web) numbers can't send templates or interactive buttons.
 * These helpers turn Cloud API payloads into plain messages with numbered options;
 * the customer replies "1", "2"… and inbound handling maps the number back to the button payload.
 */
import { renderTemplateText } from "./templates.js";

const NUMS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

function withOptions(text, options) {
  if (!options.length) return text;
  return `${text}\n\n${options.map((o, i) => `${NUMS[i] || `${i + 1}.`} ${o.title}`).join("\n")}\n\n_Reply with the number of your choice._`;
}

function mediaMessage(header, caption) {
  if (header?.type === "image" && header.image?.link) return { image: { link: header.image.link }, caption };
  if (header?.type === "document") return { document: header.document, caption };
  return { text: caption };
}

/** Cloud API session payload (text / image / interactive) -> { message, options } */
export function toGatewayMessage(payload, fallbackBody = "") {
  switch (payload?.type) {
    case "text":
      return { message: { text: payload.text.body }, options: [] };
    case "image":
      return { message: { image: { link: payload.image.link }, caption: payload.image.caption || "" }, options: [] };
    case "document":
      return { message: { document: payload.document, caption: payload.document.caption || "" }, options: [] };
    case "interactive": {
      const i = payload.interactive;
      if (i.type === "button") {
        const options = i.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }));
        return { message: mediaMessage(i.header, withOptions(i.body.text, options)), options };
      }
      if (i.type === "list") {
        const options = i.action.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
        return { message: { text: withOptions(i.body.text, options) }, options };
      }
      if (i.type === "location_request_message") {
        return { message: { text: `${i.body.text}\n\n📍 Tap 📎 → *Location* to share your location, or type your full address.` }, options: [] };
      }
      return { message: { text: i.body?.text || fallbackBody }, options: [] };
    }
    default:
      return { message: { text: fallbackBody }, options: [] };
  }
}

/** Template row + context -> plain message (header media, body, numbered quick replies, links). */
export function templateToGatewayMessage(tpl, ctx) {
  let text = renderTemplateText(tpl, ctx);
  if (tpl.footer) text += `\n\n_${tpl.footer}_`;
  const options = [];
  for (const b of tpl.buttons || []) {
    if (b.type === "QUICK_REPLY") options.push({ id: `${b.action || "BUTTON"}:${ctx.__ref ?? ""}`, title: b.text });
  }
  const links = (tpl.buttons || [])
    .filter((b) => b.type === "URL")
    .map((b) => `👉 ${b.text}: ${String(b.url).replace("{{1}}", ctx[b.source] || "")}`);
  if (links.length) text += `\n\n${links.join("\n")}`;
  text = withOptions(text, options);

  const h = tpl.header;
  if (h?.format === "IMAGE") {
    const v = h.url || ctx[h.source];
    if (v && typeof v === "string") return { message: { image: { link: v }, caption: text }, options };
  }
  if (h?.format === "DOCUMENT") {
    const v = h.url || ctx[h.source];
    if (v?.base64 || typeof v === "string") {
      const document = typeof v === "string" ? { link: v } : { base64: v.base64, mime: v.mime };
      return { message: { document: { ...document, filename: ctx.__filename || "file.pdf" }, caption: text }, options };
    }
  }
  return { message: { text }, options };
}

/** Customer replied "2" (or the option title) to a numbered menu: map back to the button payload. */
export function matchOption(text, options) {
  if (!options?.length || !text) return null;
  const t = String(text).trim();
  const n = Number(t.replace(/[^\d]/g, ""));
  if (/^\D{0,3}\d{1,2}\D{0,3}$/.test(t) && n >= 1 && n <= options.length) return options[n - 1].id;
  const byTitle = options.find((o) => o.title.toLowerCase() === t.toLowerCase());
  return byTitle?.id || null;
}
