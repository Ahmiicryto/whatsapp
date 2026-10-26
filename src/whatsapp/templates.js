import { config } from "../config.js";
import { sanitizeParam } from "../lib/format.js";

/** Every variable a template can use. The template builder in the portal shows this list. */
export const VARIABLES = {
  "customer.name": { label: "Customer full name", sample: "Ayesha Khan" },
  "customer.first_name": { label: "Customer first name", sample: "Ayesha" },
  "customer.phone": { label: "Customer mobile", sample: "+92 300 1234567" },
  "store.name": { label: "Store name", sample: "Glow Candles" },
  "store.domain": { label: "Store domain", sample: "glowcandles.pk" },
  "order.name": { label: "Order number", sample: "#1042" },
  "order.total": { label: "Order total", sample: "Rs 3,300" },
  "order.payment": { label: "Payment method", sample: "Cash on Delivery" },
  "order.amount_due": { label: "Amount to pay on delivery", sample: "Rs 3,300 (Cash on Delivery)" },
  "order.items": { label: "Products with qty & price", sample: "2× Lavender Candle (Rs 3,000) · 1× Gift Box (Rs 300)" },
  "order.item_count": { label: "Number of items", sample: "3" },
  "order.address": { label: "Shipping address (one line)", sample: "House 12, Street 4, DHA Phase 6, Karachi" },
  "product.title": { label: "First product title", sample: "Lavender Candle" },
  "product.image": { label: "First product image (header)", sample: "https://cdn.shopify.com/sample.jpg", media: true },
  "address.text": { label: "Address to confirm", sample: "House 12, Street 4, DHA Phase 6, Karachi" },
  "address.map_image": { label: "Map image of address (header)", sample: "map", media: true },
  "tracking.company": { label: "Courier", sample: "TCS" },
  "tracking.number": { label: "Tracking number", sample: "TCS123456789" },
  "link.code": { label: "Tracked link code (URL button)", sample: "aB3dE9" },
  "discount.code": { label: "Discount code", sample: "WA-7KQ2" },
  "discount.percent": { label: "Discount %", sample: "10" },
  "discount.days": { label: "Discount valid days", sample: "7" },
  "checkout.items": { label: "Abandoned cart items", sample: "Lavender Candle and 1 more item" },
  "checkout.total": { label: "Abandoned cart total", sample: "Rs 3,000" },
  "checkout.offer": { label: "Abandoned cart offer line", sample: "Use code WA-7KQ2 for 10% off." },
  "campaign.text": { label: "Campaign message text", sample: "Our Eid sale is live with up to 40% off!" },
  "campaign.image": { label: "Campaign image (header)", sample: "https://cdn.shopify.com/sample.jpg", media: true },
  "report.title": { label: "Report title", sample: "Daily report" },
  "report.date": { label: "Report date", sample: "25 Oct 2026" },
  "report.orders": { label: "Report: orders", sample: "48" },
  "report.revenue": { label: "Report: revenue", sample: "Rs 152,400" },
  "report.confirmed": { label: "Report: confirmed", sample: "39 (81%)" },
  "report.cancelled": { label: "Report: cancelled", sample: "4" },
  "report.pending": { label: "Report: pending", sample: "5" },
  "report.messages": { label: "Report: messages sent", sample: "131" },
  "report.read": { label: "Report: messages read", sample: "112 (85%)" },
  "report.summary": { label: "Report: AI summary", sample: "Confirmations are up 6% on last week." },
  "report.pdf": { label: "Report PDF (header)", sample: "pdf", media: true },
  "product.price": { label: "Product price", sample: "Rs 2,500" },
  "shipment.reason": { label: "Delivery problem", sample: "nobody was available" },
  "advance.amount": { label: "Advance amount", sample: "Rs 300" },
  "advance.instructions": { label: "How to pay the advance", sample: "JazzCash 0300-0000000 (Your Store)" },
  "alert.store": { label: "Alert: store", sample: "Glow Candles" },
  "alert.text": { label: "Alert text", sample: "High value order #1042 for Rs 45,000" },
};

const url = (suffix = "{{1}}") => `${config.baseUrl}/r/${suffix}`;

/**
 * Default templates installed per store. `kind` is how the platform finds the template to send.
 * Body variables reference VARIABLES keys in order ({{1}} = variables[0]).
 */
export function defaultTemplates() {
  return [
    {
      kind: "order_confirmation",
      name: "order_confirmation_v1",
      category: "UTILITY",
      header: { format: "IMAGE", source: "product.image" },
      body:
        "Hi {{1}}, thank you for shopping at {{2}}! 🛍️\n\n*Order:* {{3}}\n*Items:* {{4}}\n*Total:* {{5}} ({{6}})\n*Mobile:* {{7}}\n*Delivery address:* {{8}}\n\nPlease confirm your order using the buttons below.",
      variables: ["customer.first_name", "store.name", "order.name", "order.items", "order.total", "order.payment", "customer.phone", "order.address"],
      buttons: [
        { type: "QUICK_REPLY", text: "Confirm order", action: "CONFIRM" },
        { type: "QUICK_REPLY", text: "Change address", action: "ADDRESS" },
        { type: "QUICK_REPLY", text: "Cancel order", action: "CANCEL" },
      ],
    },
    {
      kind: "order_reminder",
      name: "order_reminder_v1",
      category: "UTILITY",
      header: null,
      body:
        "Hi {{1}}, your order {{2}} ({{3}}) from {{4}} is waiting for your confirmation. Please confirm so we can ship it to you.",
      variables: ["customer.first_name", "order.name", "order.total", "store.name"],
      buttons: [
        { type: "QUICK_REPLY", text: "Confirm order", action: "CONFIRM" },
        { type: "QUICK_REPLY", text: "Cancel order", action: "CANCEL" },
      ],
    },
    {
      kind: "address_confirmation",
      name: "address_confirmation_v1",
      category: "UTILITY",
      header: { format: "IMAGE", source: "address.map_image" },
      body: "Hi {{1}}, please confirm the delivery address for your order {{2}}:\n\n📍 {{3}}\n\nIs this address correct?",
      variables: ["customer.first_name", "order.name", "address.text"],
      buttons: [
        { type: "QUICK_REPLY", text: "Yes, correct", action: "ADDR_OK" },
        { type: "QUICK_REPLY", text: "Update address", action: "ADDRESS" },
      ],
    },
    {
      kind: "order_shipped",
      name: "order_shipped_v1",
      category: "UTILITY",
      header: null,
      body:
        "Good news {{1}}! 🚚 Your order {{2}} from {{3}} has been shipped with {{4}}.\nTracking number: {{5}}\n\nTap the button below to track your parcel.",
      variables: ["customer.first_name", "order.name", "store.name", "tracking.company", "tracking.number"],
      buttons: [{ type: "URL", text: "Track order", url: url(), source: "link.code" }],
    },
    {
      kind: "out_for_delivery",
      name: "out_for_delivery_v1",
      category: "UTILITY",
      header: null,
      body: "Hi {{1}}, your order {{2}} from {{3}} is out for delivery today 📦 Amount to pay: {{4}}. Please keep your phone nearby.",
      variables: ["customer.first_name", "order.name", "store.name", "order.amount_due"],
      buttons: [],
    },
    {
      kind: "order_delivered",
      name: "order_delivered_v1",
      category: "UTILITY",
      header: null,
      body: "Hi {{1}}, your order {{2}} from {{3}} has been delivered ✅ We hope you love it, thank you for shopping with us!",
      variables: ["customer.first_name", "order.name", "store.name"],
      buttons: [],
    },
    {
      kind: "review_request",
      name: "review_request_v1",
      category: "MARKETING",
      header: null,
      body: "Hi {{1}}, how was your order {{2}} from {{3}}? ⭐ We would love to hear your feedback.",
      variables: ["customer.first_name", "order.name", "store.name"],
      buttons: [{ type: "URL", text: "Leave a review", url: url(), source: "link.code" }],
    },
    {
      kind: "abandoned_cart",
      name: "abandoned_cart_v1",
      category: "MARKETING",
      header: { format: "IMAGE", source: "product.image" },
      body: "Hi {{1}}, you left {{2}} in your cart at {{3}} 🛒 Total: {{4}}. {{5}}\n\nTap below to complete your order.",
      variables: ["customer.first_name", "checkout.items", "store.name", "checkout.total", "checkout.offer"],
      buttons: [{ type: "URL", text: "Complete order", url: url(), source: "link.code" }],
    },
    {
      kind: "win_back",
      name: "win_back_v1",
      category: "MARKETING",
      header: null,
      body: "Hi {{1}}, we miss you at {{2}}! 💝 Enjoy {{3}}% off your next order with code {{4}}, valid for {{5}} days.",
      variables: ["customer.first_name", "store.name", "discount.percent", "discount.code", "discount.days"],
      buttons: [{ type: "URL", text: "Shop now", url: url(), source: "link.code" }],
    },
    {
      kind: "marketing_generic",
      name: "promo_message_v1",
      category: "MARKETING",
      header: { format: "IMAGE", source: "campaign.image" },
      body: "Hi {{1}}! {{2}}\n\nReply STOP to unsubscribe.",
      variables: ["customer.first_name", "campaign.text"],
      buttons: [{ type: "URL", text: "Shop now", url: url(), source: "link.code" }],
    },
    {
      kind: "daily_report",
      name: "owner_report_v1",
      category: "UTILITY",
      header: { format: "DOCUMENT", source: "report.pdf" },
      body:
        "📊 Here is your {{1}} for {{2}} ({{3}})\n\nOrders: {{4}} | Revenue: {{5}}\nConfirmed: {{6}} | Cancelled: {{7}} | Pending: {{8}}\nMessages sent: {{9}} | Read: {{10}}\n\n{{11}}\n\nThe full report is attached.",
      variables: [
        "report.title",
        "alert.store",
        "report.date",
        "report.orders",
        "report.revenue",
        "report.confirmed",
        "report.cancelled",
        "report.pending",
        "report.messages",
        "report.read",
        "report.summary",
      ],
      buttons: [],
    },
    {
      kind: "delivery_failed",
      name: "delivery_failed_v1",
      category: "UTILITY",
      header: null,
      body: "Hi {{1}}, the courier could not deliver your order {{2}} from {{3}} ({{4}}). What would you like us to do?",
      variables: ["customer.first_name", "order.name", "store.name", "shipment.reason"],
      buttons: [
        { type: "QUICK_REPLY", text: "Deliver again", action: "RESCHEDULE" },
        { type: "QUICK_REPLY", text: "Change address", action: "ADDRESS" },
        { type: "QUICK_REPLY", text: "Cancel order", action: "RTO_CANCEL" },
      ],
    },
    {
      kind: "advance_payment",
      name: "advance_payment_v1",
      category: "UTILITY",
      header: null,
      body: "Hi {{1}}, to dispatch your order {{2}} from {{3}} please pay an advance of {{4}}. The rest is paid on delivery.\n\n{{5}}\n\nThank you for shopping with us!",
      variables: ["customer.first_name", "order.name", "store.name", "advance.amount", "advance.instructions"],
      buttons: [],
    },
    {
      kind: "back_in_stock",
      name: "back_in_stock_v1",
      category: "UTILITY",
      header: { format: "IMAGE", source: "product.image" },
      body: "Good news {{1}}! {{2}} is back in stock at {{3}} 🎉 Price: {{4}}. You asked us to let you know. Tap below to order before it sells out.",
      variables: ["customer.first_name", "product.title", "store.name", "product.price"],
      buttons: [{ type: "URL", text: "Buy now", url: url(), source: "link.code" }],
    },
    {
      kind: "review_ask",
      name: "review_ask_v1",
      category: "UTILITY",
      header: { format: "IMAGE", source: "product.image" },
      body: "Hi {{1}}, how do you like your {{2}} from {{3}}? Tap a rating below, it takes 2 seconds ⭐",
      variables: ["customer.first_name", "product.title", "store.name"],
      buttons: [
        { type: "QUICK_REPLY", text: "😍 Loved it", action: "REVIEW_5" },
        { type: "QUICK_REPLY", text: "🙂 It's good", action: "REVIEW_4" },
        { type: "QUICK_REPLY", text: "😕 Not happy", action: "REVIEW_2" },
      ],
    },
    {
      kind: "owner_alert",
      name: "owner_alert_v1",
      category: "UTILITY",
      header: null,
      body: "Alert for {{1}}: {{2}}. Open your dashboard for details.",
      variables: ["alert.store", "alert.text"],
      buttons: [],
    },
  ];
}

export const TEMPLATE_KINDS = [...defaultTemplates().map((t) => t.kind), "custom"];

function mediaParam(format, value, filename) {
  const type = format.toLowerCase(); // image | document | video
  const media = typeof value === "object" && value?.id ? { id: value.id } : { link: String(value || "") };
  if (type === "document") media.filename = filename || "report.pdf";
  return { type, [type]: media };
}

/**
 * DB template row + context -> Cloud API "template" message payload.
 * ctx: flat object of VARIABLES keys plus `__ref` (id used in quick-reply payloads).
 */
export function buildTemplatePayload(tpl, ctx) {
  const components = [];
  const header = tpl.header;
  if (header && header.format && header.format !== "NONE") {
    if (header.format === "TEXT") {
      if (/\{\{1\}\}/.test(header.text || "")) {
        components.push({ type: "header", parameters: [{ type: "text", text: sanitizeParam(ctx[header.source], 60) }] });
      }
    } else {
      const value = header.url || ctx[header.source];
      if (!value) throw new Error(`Template ${tpl.name} needs a ${header.format} header (${header.source || "url"})`);
      components.push({ type: "header", parameters: [mediaParam(header.format, value, ctx.__filename)] });
    }
  }
  const vars = tpl.variables || [];
  if (vars.length) {
    components.push({
      type: "body",
      parameters: vars.map((v) => {
        const key = typeof v === "string" ? v : v.source;
        const value = typeof v === "object" && v.value !== undefined ? v.value : ctx[key];
        return { type: "text", text: sanitizeParam(value) };
      }),
    });
  }
  (tpl.buttons || []).forEach((b, index) => {
    if (b.type === "QUICK_REPLY") {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(index),
        parameters: [{ type: "payload", payload: `${b.action || "BUTTON"}:${ctx.__ref ?? ""}` }],
      });
    } else if (b.type === "URL" && /\{\{1\}\}/.test(b.url || "")) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(index),
        parameters: [{ type: "text", text: String(ctx[b.source] || "x") }],
      });
    }
  });
  return {
    type: "template",
    template: { name: tpl.name, language: { code: tpl.language || "en" }, components },
  };
}

/** Render the body text with values (for message history / previews). */
export function renderTemplateText(tpl, ctx) {
  const vars = tpl.variables || [];
  return String(tpl.body || "").replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = vars[Number(n) - 1];
    if (!v) return "";
    const key = typeof v === "string" ? v : v.source;
    const value = typeof v === "object" && v.value !== undefined ? v.value : ctx[key];
    return sanitizeParam(value);
  });
}

/** Checks Meta's structural rules before we submit. Returns a list of problems. */
export function validateTemplate(tpl) {
  const problems = [];
  if (!/^[a-z0-9_]{1,512}$/.test(tpl.name || "")) problems.push("Name must use lowercase letters, numbers and underscores only.");
  const body = String(tpl.body || "");
  if (!body.trim()) problems.push("Body is required.");
  if (body.length > 1024) problems.push("Body must be 1024 characters or fewer.");
  const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const expected = nums.length ? Math.max(...nums) : 0;
  for (let i = 1; i <= expected; i++) if (!nums.includes(i)) problems.push(`Variable {{${i}}} is missing (variables must be sequential).`);
  if ((tpl.variables || []).length !== expected) problems.push(`Body uses ${expected} variables but ${(tpl.variables || []).length} are mapped.`);
  if (/^\s*\{\{\d+\}\}/.test(body)) problems.push("Body can't start with a variable.");
  if (/\{\{\d+\}\}\s*[.!?]?\s*$/.test(body)) problems.push("Body can't end with a variable.");
  const buttons = tpl.buttons || [];
  if (buttons.length > 10) problems.push("Maximum 10 buttons.");
  buttons.forEach((b, i) => {
    if (!b.text || b.text.length > 25) problems.push(`Button ${i + 1} text must be 1-25 characters.`);
    if (b.type === "URL" && !/^https:\/\//.test(b.url || "")) problems.push(`Button ${i + 1} URL must start with https://`);
    if (b.type === "URL" && /\{\{1\}\}/.test(b.url || "") && !/\{\{1\}\}$/.test(b.url)) problems.push(`Button ${i + 1}: {{1}} must be at the end of the URL.`);
  });
  if (tpl.footer && tpl.footer.length > 60) problems.push("Footer must be 60 characters or fewer.");
  return problems;
}

/** DB template row -> Meta message_templates create body. */
export function toMetaDefinition(tpl, { headerHandle } = {}) {
  const components = [];
  const h = tpl.header;
  if (h && h.format && h.format !== "NONE") {
    if (h.format === "TEXT") {
      const c = { type: "HEADER", format: "TEXT", text: h.text };
      if (/\{\{1\}\}/.test(h.text || "")) c.example = { header_text: [VARIABLES[h.source]?.sample || "Sample"] };
      components.push(c);
    } else {
      components.push({ type: "HEADER", format: h.format, example: { header_handle: [headerHandle] } });
    }
  }
  const body = { type: "BODY", text: tpl.body };
  const vars = tpl.variables || [];
  if (vars.length) {
    body.example = {
      body_text: [vars.map((v) => (typeof v === "object" && v.value ? v.value : VARIABLES[typeof v === "string" ? v : v.source]?.sample || "Sample"))],
    };
  }
  components.push(body);
  if (tpl.footer) components.push({ type: "FOOTER", text: tpl.footer });
  if (tpl.buttons?.length) {
    components.push({
      type: "BUTTONS",
      buttons: tpl.buttons.map((b) => {
        if (b.type === "QUICK_REPLY") return { type: "QUICK_REPLY", text: b.text };
        if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone };
        const btn = { type: "URL", text: b.text, url: b.url };
        if (/\{\{1\}\}/.test(b.url)) btn.example = [b.url.replace("{{1}}", VARIABLES[b.source]?.sample || "abc123")];
        return btn;
      }),
    });
  }
  return { name: tpl.name, language: tpl.language || "en", category: tpl.category, components };
}
