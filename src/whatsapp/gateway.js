/**
 * Client for the optional WhatsApp Web gateway (gateway/ folder, runs on an always-on host).
 * Numbers linked by scanning a QR code send through it instead of the Cloud API.
 * Unofficial: WhatsApp may restrict numbers that send bulk or unsolicited messages.
 */
import { config } from "../config.js";
import { requestJson, ApiError } from "../lib/http.js";
import { hmacHex, safeEqual } from "../lib/crypto.js";

export class GatewayError extends ApiError {
  get permanent() {
    return this.status === 400 || this.status === 404;
  }
}

export const gatewayConfigured = () => !!(config.gateway.url && config.gateway.secret);

async function call(method, path, body) {
  if (!gatewayConfigured()) throw new GatewayError("QR login isn't set up on this server (GATEWAY_URL / GATEWAY_SECRET).", { status: 503 });
  const res = await requestJson(`${config.gateway.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.gateway.secret}` },
    body,
    timeoutMs: 45000,
  });
  if (!res.ok) throw new GatewayError(res.json?.error || `Gateway error ${res.status}`, { status: res.status, body: res.json });
  return res.json;
}

/** Starts (or resumes) a session. Returns { status: 'qr'|'connecting'|'connected'|'logged_out', qr?, phone?, name? } */
export const startSession = (session) => call("POST", `/sessions/${encodeURIComponent(session)}/start`, {});
export const sessionStatus = (session) => call("GET", `/sessions/${encodeURIComponent(session)}`);
export const logoutSession = (session) => call("DELETE", `/sessions/${encodeURIComponent(session)}`);

/**
 * message: { text } | { image: { link|base64, mime }, caption } | { document: { link|base64, mime, filename }, caption }
 * Returns the WhatsApp message id.
 */
export async function sendViaGateway(session, to, message) {
  const r = await call("POST", `/sessions/${encodeURIComponent(session)}/send`, { to, ...message });
  return r.id;
}

export function verifyGatewaySignature(rawBody, header) {
  if (!config.gateway.secret || !rawBody || !header) return false;
  return safeEqual(hmacHex(config.gateway.secret, rawBody), String(header));
}
