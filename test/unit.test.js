import "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, toWaId } from "../src/lib/phone.js";
import { sanitizeParam, itemsSummary, formatAddress } from "../src/lib/format.js";
import { quietHoursEnd, startOfLocalDay, zonedParts } from "../src/lib/time.js";
import { encrypt, decrypt } from "../src/lib/crypto.js";
import { buildTemplatePayload, validateTemplate, defaultTemplates, toMetaDefinition } from "../src/whatsapp/templates.js";
import { parseWebhook, verifyMetaSignature } from "../src/whatsapp/webhookParser.js";
import { verifyShopifyHmac } from "../src/shopify/webhooks.js";
import { normalizeWebhookOrder } from "../src/shopify/orders.js";
import { keywordIntent } from "../src/ai/features.js";
import { buildSegmentWhere } from "../src/services/marketing.js";
import { heuristicPenalty } from "../src/google/address.js";
import { deepMerge, DEFAULT_SETTINGS } from "../src/services/settings.js";
import { verifyOAuthQuery } from "../src/shopify/oauth.js";
import { shopifyHmac, metaSig } from "./helpers.js";
import crypto from "node:crypto";

test("phone normalisation handles local, international and junk numbers", () => {
  assert.equal(normalizePhone("0300 1234567", "PK"), "+923001234567");
  assert.equal(normalizePhone("923001234567", "PK"), "+923001234567");
  assert.equal(normalizePhone("+44 7911 123456", "PK"), "+447911123456");
  assert.equal(normalizePhone("12345", "PK"), null);
  assert.equal(toWaId("+923001234567"), "923001234567");
});

test("template params are sanitised for Meta rules", () => {
  assert.equal(sanitizeParam("a\nb\tc"), "a · b · c");
  assert.equal(sanitizeParam("x     y"), "x y");
  assert.equal(sanitizeParam(""), "-");
  assert.equal(sanitizeParam(null), "-");
});

test("items summary shows qty, price and truncates", () => {
  const items = [
    { title: "Candle", quantity: 2, price: 750, variant_title: "Lavender" },
    { title: "Gift box", quantity: 1, price: 300, variant_title: "Default Title" },
  ];
  const s = itemsSummary(items, "PKR");
  assert.match(s, /2× Candle - Lavender/);
  assert.match(s, /1× Gift box \(/);
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `Product number ${i}`, quantity: 1, price: 100 }));
  assert.match(itemsSummary(many, "PKR", 120), /\+\d+ more$/);
});

test("address formatting drops blanks and duplicates", () => {
  assert.equal(formatAddress({ address1: "House 1", city: "Karachi", province: "karachi", country: "Pakistan" }), "House 1, Karachi, Pakistan");
});

test("encryption round-trips", () => {
  const enc = encrypt("shpat_secret");
  assert.notEqual(enc, "shpat_secret");
  assert.equal(decrypt(enc), "shpat_secret");
});

test("quiet hours spanning midnight", () => {
  const quiet = { enabled: true, start: "22:00", end: "09:00" };
  const late = new Date("2026-10-25T18:30:00Z"); // 23:30 in Karachi (+5)
  const end = quietHoursEnd(late, "Asia/Karachi", quiet);
  assert.ok(end);
  assert.equal(zonedParts(end, "Asia/Karachi").hour, 9);
  assert.equal(quietHoursEnd(new Date("2026-10-25T07:00:00Z"), "Asia/Karachi", quiet), null); // 12:00 local
});

test("local day start respects timezone", () => {
  assert.equal(startOfLocalDay("2026-10-25", "Asia/Karachi").toISOString(), "2026-10-24T19:00:00.000Z");
});

test("default templates pass validation", () => {
  for (const t of defaultTemplates()) {
    assert.deepEqual(validateTemplate(t), [], t.name);
  }
});

test("template payload builds header, body params and button payloads", () => {
  const tpl = defaultTemplates().find((t) => t.kind === "order_confirmation");
  const ctx = {
    __ref: 42,
    "customer.first_name": "Ayesha",
    "store.name": "Glow",
    "order.name": "#1001",
    "order.items": "2× Candle",
    "order.total": "Rs 1,500",
    "order.payment": "Cash on Delivery",
    "customer.phone": "+92 300 1234567",
    "order.address": "House 1\nKarachi",
    "product.image": "https://cdn/x.jpg",
  };
  const p = buildTemplatePayload({ ...tpl, language: "en" }, ctx);
  assert.equal(p.template.name, "order_confirmation_v1");
  const header = p.template.components.find((c) => c.type === "header");
  assert.equal(header.parameters[0].image.link, "https://cdn/x.jpg");
  const body = p.template.components.find((c) => c.type === "body");
  assert.equal(body.parameters.length, 8);
  assert.equal(body.parameters[7].text, "House 1 · Karachi");
  const buttons = p.template.components.filter((c) => c.type === "button");
  assert.deepEqual(buttons.map((b) => b.parameters[0].payload), ["CONFIRM:42", "ADDRESS:42", "CANCEL:42"]);
});

test("meta definition includes examples", () => {
  const tpl = defaultTemplates().find((t) => t.kind === "order_shipped");
  const def = toMetaDefinition({ ...tpl, language: "en" });
  const btn = def.components.find((c) => c.type === "BUTTONS").buttons[0];
  assert.equal(btn.url, "https://app.example.com/r/{{1}}");
  assert.equal(btn.example[0], "https://app.example.com/r/aB3dE9");
  assert.equal(def.components.find((c) => c.type === "BODY").example.body_text[0].length, 5);
});

test("validation catches Meta rule violations", () => {
  const problems = validateTemplate({ name: "Bad Name", body: "{{1}} hello {{3}}", variables: ["a"], buttons: [] });
  assert.ok(problems.some((p) => p.includes("lowercase")));
  assert.ok(problems.some((p) => p.includes("{{2}} is missing")));
  assert.ok(problems.some((p) => p.includes("start with a variable")));
  assert.ok(problems.some((p) => p.includes("end with a variable")));
});

test("signatures verify only with the right secret", () => {
  const raw = Buffer.from(JSON.stringify({ a: 1 }));
  assert.ok(verifyShopifyHmac(raw, shopifyHmac("s", raw), "s"));
  assert.ok(!verifyShopifyHmac(raw, shopifyHmac("other", raw), "s"));
  assert.ok(verifyMetaSignature(raw, metaSig("m", raw), "m"));
  assert.ok(!verifyMetaSignature(raw, "sha256=00", "m"));
});

test("shopify oauth query hmac", () => {
  const query = { code: "abc", shop: "glow.myshopify.com", state: "xyz", timestamp: "1700000000" };
  const msg = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&");
  const hmac = crypto.createHmac("sha256", "shopify-app-secret").update(msg).digest("hex");
  assert.ok(verifyOAuthQuery({ ...query, hmac }));
  assert.ok(!verifyOAuthQuery({ ...query, hmac: "bad" }));
});

test("webhook parser flattens messages, buttons, locations and statuses", () => {
  const events = parseWebhook({
    entry: [
      {
        id: "W",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "1" },
              contacts: [{ wa_id: "92300", profile: { name: "A" } }],
              messages: [
                { from: "92300", id: "m1", type: "button", button: { text: "Confirm order", payload: "CONFIRM:5" } },
                { from: "92300", id: "m2", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "ADDR_OK:5", title: "Yes" } } },
                { from: "92300", id: "m3", type: "location", location: { latitude: 24.8, longitude: 67.0 } },
              ],
              statuses: [{ id: "m0", status: "read", recipient_id: "92300", timestamp: "1700000000" }],
            },
          },
        ],
      },
    ],
  });
  assert.equal(events.length, 4);
  assert.equal(events[0].payload, "CONFIRM:5");
  assert.equal(events[1].payload, "ADDR_OK:5");
  assert.equal(events[2].location.lat, 24.8);
  assert.equal(events[3].status, "read");
});

test("webhook order normalisation detects COD and phone", () => {
  const n = normalizeWebhookOrder({
    id: 1,
    name: "#1001",
    payment_gateway_names: ["Cash on Delivery (COD)"],
    shipping_address: { phone: "0300-1234567", city: "Lahore", address1: "H1" },
    line_items: [{ id: 9, title: "Candle", quantity: 2, price: "750.00", variant_id: 501 }],
    total_price: "1500.00",
    tags: "vip, eid",
  });
  assert.equal(n.isCod, true);
  assert.equal(n.phoneRaw, "0300-1234567");
  assert.deepEqual(n.tags, ["vip", "eid"]);
  assert.equal(n.lineItems[0].price, 750);
});

test("keyword intent fallback (English + Roman Urdu)", () => {
  assert.equal(keywordIntent("haan ji confirm").intent, "confirm");
  assert.equal(keywordIntent("nahi chahiye cancel kar do").intent, "cancel");
  assert.equal(keywordIntent("STOP").intent, "opt_out");
  assert.equal(keywordIntent("mera parcel kahan hai").intent, "where_is_order");
});

test("segment rules compile to parameterised SQL and reject unknown fields", () => {
  const params = [1];
  const sql = buildSegmentWhere(
    { match: "all", conditions: [{ field: "total_spent", op: "gte", value: 5000 }, { field: "city", op: "in", value: "Karachi, Lahore" }, { field: "tag", op: "contains", value: "vip" }] },
    params
  );
  assert.match(sql, /c\.total_spent/);
  assert.deepEqual(params.slice(1), [5000, ["karachi", "lahore"], "vip"]);
  assert.throws(() => buildSegmentWhere({ conditions: [{ field: "password; drop", op: "eq", value: 1 }] }, []));
});

test("address heuristics flag weak addresses", () => {
  assert.ok(heuristicPenalty({ address1: "near masjid", city: "" }).penalty >= 40);
  assert.equal(heuristicPenalty({ address1: "House 12, Street 4, Block B", city: "Karachi" }).penalty, 0);
});

test("settings deep merge keeps defaults", () => {
  const s = deepMerge(DEFAULT_SETTINGS, { confirmation: { scope: "all" } });
  assert.equal(s.confirmation.scope, "all");
  assert.equal(s.confirmation.reminderHours, 6);
  assert.equal(s.tags.confirmed, "wa-confirmed");
});
