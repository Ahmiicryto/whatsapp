import { config } from "../config.js";
import { requestJson, ApiError } from "../lib/http.js";

const graph = () => `https://graph.facebook.com/${config.meta.graphVersion}`;

// Errors that will never succeed on retry.
const PERMANENT_CODES = new Set([
  100, // invalid parameter
  131008, // required parameter missing
  131009, // parameter value invalid
  131026, // message undeliverable (not on WhatsApp / old app)
  131047, // re-engagement: 24h window closed
  131050, // user stopped marketing messages
  131051, // unsupported message type
  132000, // template param count mismatch
  132001, // template does not exist
  132005, // template hydrated text too long
  132007, // template format policy violated
  132012, // template param format mismatch
  132015, // template paused
  132016, // template disabled
  132018, // template param has newlines/tabs
  133010, // phone number not registered
]);

export class WhatsAppError extends ApiError {
  get permanent() {
    return PERMANENT_CODES.has(Number(this.code));
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function raise(res, label) {
  const e = res.json?.error || {};
  throw new WhatsAppError(`${label}: ${e.message || res.status}${e.error_data?.details ? ` (${e.error_data.details})` : ""}`, {
    status: res.status,
    body: res.json,
    code: e.code,
  });
}

/** Sends any message payload; returns the wamid. */
export async function sendMessage(wa, to, payload) {
  const res = await requestJson(`${graph()}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: authHeaders(wa.token),
    body: { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload },
  });
  if (!res.ok) raise(res, "WhatsApp send failed");
  return res.json.messages?.[0]?.id;
}

export const textPayload = (body, previewUrl = true) => ({ type: "text", text: { body, preview_url: previewUrl } });

export const imagePayload = ({ link, id, caption }) => ({ type: "image", image: { ...(id ? { id } : { link }), caption } });

export const documentPayload = ({ link, id, filename, caption }) => ({
  type: "document",
  document: { ...(id ? { id } : { link }), filename, caption },
});

/** Interactive reply buttons (max 3, title max 20 chars). Free inside the 24h window. */
export function buttonsPayload({ body, buttons, header, footer }) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      ...(header ? { header } : {}),
      body: { text: body.slice(0, 1024) },
      ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })),
      },
    },
  };
}

/** Interactive list (max 10 rows). */
export function listPayload({ body, button, sections }) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body.slice(0, 1024) },
      action: {
        button: button.slice(0, 20),
        sections: sections.map((s) => ({
          title: s.title?.slice(0, 24),
          rows: s.rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), description: r.description?.slice(0, 72) })),
        })),
      },
    },
  };
}

export function locationRequestPayload(body) {
  return {
    type: "interactive",
    interactive: { type: "location_request_message", body: { text: body.slice(0, 1024) }, action: { name: "send_location" } },
  };
}

export async function markRead(wa, wamid) {
  await requestJson(`${graph()}/${wa.phoneNumberId}/messages`, {
    method: "POST",
    headers: authHeaders(wa.token),
    body: { messaging_product: "whatsapp", status: "read", message_id: wamid },
  }).catch(() => {});
}

/** Upload media to WhatsApp, returns media id (valid ~30 days). */
export async function uploadMedia(wa, buffer, mime, filename = "file") {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([buffer], { type: mime }), filename);
  const res = await requestJson(`${graph()}/${wa.phoneNumberId}/media`, {
    method: "POST",
    headers: authHeaders(wa.token),
    body: form,
    timeoutMs: 60000,
  });
  if (!res.ok) raise(res, "WhatsApp media upload failed");
  return res.json.id;
}

/** Downloads inbound media (voice notes, images) -> { buffer, mime }. */
export async function downloadMedia(wa, mediaId) {
  const meta = await requestJson(`${graph()}/${mediaId}`, { headers: authHeaders(wa.token) });
  if (!meta.ok) raise(meta, "WhatsApp media lookup failed");
  const res = await requestJson(meta.json.url, { headers: authHeaders(wa.token), raw: true, timeoutMs: 60000 });
  if (!res.ok) throw new WhatsAppError(`media download failed (${res.status})`, { status: res.status });
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: meta.json.mime_type };
}

export async function getPhoneNumberInfo(wa) {
  const res = await requestJson(
    `${graph()}/${wa.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
    { headers: authHeaders(wa.token) }
  );
  if (!res.ok) raise(res, "Could not read WhatsApp number");
  return res.json;
}

/** Subscribes our Meta app to the WABA so its webhooks reach us. */
export async function subscribeApp(wa) {
  if (!wa.wabaId) return;
  const res = await requestJson(`${graph()}/${wa.wabaId}/subscribed_apps`, { method: "POST", headers: authHeaders(wa.token) });
  if (!res.ok) raise(res, "Subscribing app to WABA failed");
}

export async function createTemplate(wa, definition) {
  const res = await requestJson(`${graph()}/${wa.wabaId}/message_templates`, {
    method: "POST",
    headers: authHeaders(wa.token),
    body: definition,
  });
  if (!res.ok) raise(res, "Template submission failed");
  return res.json; // { id, status, category }
}

export async function listTemplates(wa) {
  const out = [];
  let url = `${graph()}/${wa.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=200`;
  for (let i = 0; i < 10 && url; i++) {
    const res = await requestJson(url, { headers: authHeaders(wa.token) });
    if (!res.ok) raise(res, "Template list failed");
    out.push(...(res.json.data || []));
    url = res.json.paging?.next || null;
  }
  return out;
}

export async function deleteTemplate(wa, name) {
  const res = await requestJson(`${graph()}/${wa.wabaId}/message_templates?name=${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: authHeaders(wa.token),
  });
  if (!res.ok) raise(res, "Template delete failed");
}

/**
 * Resumable Upload API: needed to give Meta an example file for IMAGE/DOCUMENT template headers.
 * Returns the header handle ("4::aW...").
 */
export async function uploadHeaderExample(wa, buffer, mime) {
  if (!config.meta.appId) throw new WhatsAppError("META_APP_ID is required to submit templates with media headers");
  const start = await requestJson(
    `${graph()}/${config.meta.appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mime)}`,
    { method: "POST", headers: authHeaders(wa.token) }
  );
  if (!start.ok) raise(start, "Upload session failed");
  const res = await requestJson(`${graph()}/${start.json.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${wa.token}`, file_offset: "0", "Content-Type": mime },
    body: buffer,
    timeoutMs: 60000,
  });
  if (!res.ok) raise(res, "Upload failed");
  return res.json.h;
}
