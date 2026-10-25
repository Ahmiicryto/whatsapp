/**
 * Fills a database with a demo account so the portal can be explored without Shopify/Meta.
 *   DATABASE_URL=... node scripts/seed-demo.js
 * Login: demo@example.com / demopassword
 */
import { pool, one, query } from "../src/db/pool.js";
import { bootstrap } from "../src/bootstrap.js";
import { encrypt, randomToken } from "../src/lib/crypto.js";
import { hashPassword } from "../src/api/auth.js";
import { defaultTemplates } from "../src/whatsapp/templates.js";
import { formatAddress } from "../src/lib/format.js";
import { computeRfm } from "../src/services/marketing.js";
import { generateReport } from "../src/services/reports.js";

await bootstrap();

const email = "demo@example.com";
if (await one(`SELECT 1 FROM users WHERE email=$1`, [email])) {
  console.log("Demo data already exists. Login: demo@example.com / demopassword");
  process.exit(0);
}

const user = await one(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,'Demo Owner') RETURNING id`, [email, await hashPassword("demopassword")]);
const account = await one(`INSERT INTO accounts (name) VALUES ('Glow Group') RETURNING id`);
await query(`INSERT INTO memberships (user_id, account_id, role) VALUES ($1,$2,'owner')`, [user.id, account.id]);

const number = await one(
  `INSERT INTO whatsapp_numbers (account_id, phone_number_id, waba_id, display_number, verified_name, token_enc, webhook_key, quality_rating, messaging_limit)
   VALUES ($1,'100000000000001','200000000000001','+92 300 0000000','Glow Candles',$2,$3,'GREEN','TIER_1K') RETURNING id`,
  [account.id, encrypt("demo-token"), randomToken(12)]
);

const storesDef = [
  { name: "Glow Candles", domain: "glow-candles.myshopify.com" },
  { name: "Bloom Skincare", domain: "bloom-skin.myshopify.com" },
];
const products = [
  ["Lavender Candle", 1500, "https://images.unsplash.com/photo-1602874801007-bd458bb1b8b6?w=400"],
  ["Vanilla Candle", 1400, "https://images.unsplash.com/photo-1603006905003-be475563bc59?w=400"],
  ["Gift Box", 600, "https://images.unsplash.com/photo-1549465220-1a8b9238cd48?w=400"],
  ["Rose Face Serum", 2400, "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=400"],
  ["Aloe Gel", 900, "https://images.unsplash.com/photo-1596755389378-c31d21fd1273?w=400"],
];
const cities = [
  ["Karachi", 24.8607, 67.0011],
  ["Lahore", 31.5204, 74.3587],
  ["Islamabad", 33.6844, 73.0479],
  ["Rawalpindi", 33.5651, 73.0169],
  ["Faisalabad", 31.4504, 73.135],
  ["Multan", 30.1575, 71.5249],
];
const names = ["Ayesha Khan", "Bilal Ahmed", "Sara Ali", "Usman Tariq", "Fatima Noor", "Hamza Iqbal", "Zainab Raza", "Ali Hassan", "Maryam Shah", "Omar Farooq", "Hina Javed", "Saad Malik"];
const statuses = ["confirmed", "confirmed", "confirmed", "delivered", "fulfilled", "awaiting_reply", "no_response", "cancelled_by_customer", "confirmed", "delivered"];
const rand = (a) => a[Math.floor(Math.random() * a.length)];

let orderNo = 1000;
for (const [si, sd] of storesDef.entries()) {
  const store = await one(
    `INSERT INTO stores (account_id, name, shopify_domain, shopify_token_enc, webhook_secret_enc, connection_type, whatsapp_number_id, currency, timezone, country, settings)
     VALUES ($1,$2,$3,$4,$5,'manual',$6,'PKR','Asia/Karachi','PK',$7) RETURNING id`,
    [account.id, sd.name, sd.domain, encrypt("shpat_demo"), encrypt("demo"), number.id, { ai: { knowledgeBase: "Delivery in 3-5 days. Free delivery above Rs 3,000." } }]
  );
  for (const t of defaultTemplates()) {
    await query(
      `INSERT INTO templates (store_id, kind, name, language, category, header, body, buttons, variables, status) VALUES ($1,$2,$3,'en',$4,$5,$6,$7,$8,'APPROVED')`,
      [store.id, t.kind, t.name, t.category, t.header, t.body, JSON.stringify(t.buttons), JSON.stringify(t.variables)]
    );
  }
  for (let i = 0; i < 70; i++) {
    const name = rand(names);
    const [city, lat, lng] = rand(cities);
    const phone = `+92300${String(1000000 + Math.floor(Math.random() * 8999999))}`;
    const created = new Date(Date.now() - Math.floor(Math.random() * 30 * 86400000));
    const items = [rand(products.slice(si * 3, si * 3 + 3).length ? products.slice(si * 3, si * 3 + 3) : products)];
    if (Math.random() > 0.6) items.push(rand(products));
    const qty = 1 + Math.floor(Math.random() * 2);
    const total = items.reduce((s, p) => s + p[1] * qty, 0);
    const status = rand(statuses);
    const score = Math.floor(30 + Math.random() * 70);
    const addr = { firstName: name.split(" ")[0], name, address1: `House ${Math.floor(Math.random() * 300)}, Street ${Math.floor(Math.random() * 20)}`, address2: "Block B", city, countryCode: "PK", country: "Pakistan" };
    const customer = await one(
      `INSERT INTO customers (store_id, name, first_name, phone_e164, city, country, wa_opt_in, opt_in_source) VALUES ($1,$2,$3,$4,$5,'PK',$6,'shopify') RETURNING id`,
      [store.id, name, name.split(" ")[0], phone, city, Math.random() > 0.4]
    );
    const order = await one(
      `INSERT INTO orders (store_id, customer_id, shopify_order_id, name, customer_name, first_name, phone_e164, total, subtotal, currency, gateway, is_cod,
          shipping_address, address_text, address_status, address_score, lat, lng, status, risk_score, risk_reasons, shopify_tags, shopify_created_at,
          confirmation_sent_at, confirmed_at, needs_attention)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'PKR','Cash on Delivery (COD)',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
      [
        store.id, customer.id, 900000 + orderNo, `#${++orderNo}`, name, name.split(" ")[0], phone, total, Math.random() > 0.15, addr, formatAddress(addr),
        score >= 80 ? "verified" : score >= 50 ? (Math.random() > 0.5 ? "updated" : "needs_confirmation") : "needs_update", score,
        lat + (Math.random() - 0.5) * 0.1, lng + (Math.random() - 0.5) * 0.1, status, Math.floor(Math.random() * 70),
        JSON.stringify(["Prepaid order"]), status === "confirmed" ? ["wa-sent", "wa-confirmed"] : ["wa-sent"], created,
        created, ["confirmed", "delivered", "fulfilled"].includes(status) ? new Date(created.getTime() + 3600000) : null, status === "no_response",
      ]
    );
    for (const p of items) {
      await query(`INSERT INTO order_items (order_id, store_id, title, quantity, price, image_url) VALUES ($1,$2,$3,$4,$5,$6)`, [order.id, store.id, p[0], qty, p[1], p[2]]);
    }
    const conv = await one(
      `INSERT INTO conversations (store_id, customer_id, phone_e164, name, last_message_at, last_inbound_at, last_message_preview, needs_human, unread)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (store_id, phone_e164) DO UPDATE SET last_message_at=EXCLUDED.last_message_at RETURNING id`,
      [store.id, customer.id, phone, name, created, status === "awaiting_reply" ? null : created, status === "confirmed" ? "Confirm order" : "Assalam o alaikum, order kab ayega?", Math.random() > 0.85, Math.random() > 0.7 ? 1 : 0]
    );
    await query(
      `INSERT INTO messages (store_id, conversation_id, order_id, customer_id, direction, kind, template_name, category, body, status, cost_estimate, created_at)
       VALUES ($1,$2,$3,$4,'out','confirmation','order_confirmation_v1','utility',$5,$6,0.01,$7)`,
      [store.id, conv.id, order.id, customer.id, `Hi ${name.split(" ")[0]}, thank you for shopping at ${sd.name}! Order #${orderNo}…`, rand(["read", "read", "delivered", "sent", "failed"]), created]
    );
    if (status !== "awaiting_reply") {
      await query(
        `INSERT INTO messages (store_id, conversation_id, order_id, customer_id, direction, kind, body, status, created_at) VALUES ($1,$2,$3,$4,'in','inbound',$5,'received',$6)`,
        [store.id, conv.id, order.id, customer.id, status === "cancelled_by_customer" ? "Cancel order" : "Confirm order", new Date(created.getTime() + 1800000)]
      );
      await query(
        `INSERT INTO messages (store_id, conversation_id, order_id, customer_id, direction, kind, body, status, ai_generated, created_at) VALUES ($1,$2,$3,$4,'out','confirmed_ack',$5,'read',$6,$7)`,
        [store.id, conv.id, order.id, customer.id, "Thank you! Your order is confirmed ✅", Math.random() > 0.5, new Date(created.getTime() + 1801000)]
      );
    }
  }
  await query(
    `UPDATE customers c SET orders_count=s.n, total_spent=s.t, first_order_at=s.f, last_order_at=s.l
       FROM (SELECT customer_id, count(*) n, sum(total) t, min(shopify_created_at) f, max(shopify_created_at) l FROM orders WHERE store_id=$1 GROUP BY 1) s
      WHERE c.id=s.customer_id`,
    [store.id]
  );
  await computeRfm(store.id);
  await query(`INSERT INTO owner_contacts (account_id, store_id, name, phone_e164) VALUES ($1,$2,'Owner','+923211234567')`, [account.id, store.id]);
  await generateReport({ accountId: account.id, storeId: store.id, type: "daily" });
}

console.log("Demo data created. Login: demo@example.com / demopassword");
await pool.end();
