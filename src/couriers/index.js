import { one, query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { postex } from "./postex.js";
import { leopards } from "./leopards.js";
import { trax } from "./trax.js";
import { custom } from "./custom.js";
import { manual } from "./manual.js";

export { normalizeStatus, STATUSES, FINAL_STATUSES, PROBLEM_STATUSES } from "./common.js";

export const PROVIDERS = { postex, leopards, trax, custom, manual };

/** Public description for the portal (no secrets). */
export function providerList() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, fields: p.fields }));
}

/** Split submitted fields into encrypted credentials and plain settings. */
export function splitFields(providerId, values, existing = {}) {
  const p = PROVIDERS[providerId];
  const creds = { ...(existing.creds || {}) };
  const settings = { ...(existing.settings || {}) };
  for (const f of p.fields) {
    const v = values[f.key];
    if (v === undefined || (f.secret && v === "")) continue; // empty secret = keep the stored one
    if (f.setting) settings[f.key] = v;
    else creds[f.key] = v;
  }
  if (values.baseUrl !== undefined) settings.baseUrl = values.baseUrl || undefined;
  return { creds, settings };
}

export function loadCourier(row) {
  let creds = {};
  try {
    creds = row.credentials_enc ? JSON.parse(decrypt(row.credentials_enc)) : {};
  } catch {
    creds = {};
  }
  const c = { row, provider: PROVIDERS[row.provider], creds, settings: { ...(row.settings || {}) } };
  c.saveSettings = () => query(`UPDATE store_couriers SET settings=$2, updated_at=now() WHERE id=$1`, [row.id, c.settings]);
  return c;
}

export async function courierById(storeId, courierId) {
  const row = courierId
    ? await one(`SELECT * FROM store_couriers WHERE id=$1 AND store_id=$2 AND active`, [courierId, storeId])
    : await one(`SELECT * FROM store_couriers WHERE store_id=$1 AND active ORDER BY is_default DESC, id LIMIT 1`, [storeId]);
  return row ? loadCourier(row) : null;
}

export const encryptCreds = (creds) => encrypt(JSON.stringify(creds));
