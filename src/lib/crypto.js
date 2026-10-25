import crypto from "node:crypto";
import { config } from "../config.js";

function key() {
  if (config.encryptionKey) {
    const buf = Buffer.from(config.encryptionKey, "base64");
    if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
    return buf;
  }
  // Development fallback derived from the session secret. Production requires ENCRYPTION_KEY.
  return crypto.createHash("sha256").update(`enc:${config.sessionSecret}`).digest();
}

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decrypt(value) {
  if (!value) return null;
  const [version, iv, tag, data] = value.split(":");
  if (version !== "v1") throw new Error("Unknown ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hmacBase64(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64");
}

export function hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Short signed token used for public media URLs (map images etc.). */
export function sign(value) {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url").slice(0, 22);
}

export function verifySignature(value, signature) {
  return safeEqual(sign(value), String(signature || ""));
}
