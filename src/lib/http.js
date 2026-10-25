/**
 * Small fetch wrapper used for every outbound API call (Shopify, Meta, Google, OpenAI).
 * Keeping it in one place makes the integrations easy to stub in tests.
 */
export class ApiError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 20000, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = { method, headers: { ...headers }, signal: controller.signal };
    if (body !== undefined) {
      if (body instanceof FormData || Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === "string") {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
      }
    }
    const res = await fetch(url, init);
    if (raw) return res;
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, ok: res.ok, headers: res.headers, json };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
