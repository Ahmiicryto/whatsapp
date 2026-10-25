import { aiJson, aiText } from "./provider.js";
import { VARIABLES } from "../whatsapp/templates.js";

const str = { type: "string" };
const nstr = { type: ["string", "null"] };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

export const INTENTS = ["confirm", "cancel", "change_address", "where_is_order", "question", "complaint", "opt_out", "greeting", "other"];

// ---------- Keyword fallback (no AI / AI failed) ----------
const KW = {
  opt_out: /^\s*(stop|unsubscribe|band karo|band kro|mat bhejo|no more)\b/i,
  confirm: /^\s*(yes|y|yeah|yep|ok|okay|confirm(ed)?|haan|han|hn|ji|jee|g|theek|thik|done|sure|sahi|بالکل|ہاں|جی|ٹھیک)\b|✅|👍/i,
  cancel: /\b(cancel|nahi|nhi|nahin|no\b|don'?t want|mat bhejo|نہیں|منسوخ)\b|❌/i,
  change_address: /\b(address|pata|location|ghar|change address|new address)\b/i,
  where_is_order: /\b(where|kahan|kab|track|tracking|status|deliver(y|ed)?|parcel)\b/i,
};

export function keywordIntent(text) {
  const t = String(text || "");
  for (const intent of ["opt_out", "cancel", "confirm", "change_address", "where_is_order"]) {
    if (KW[intent].test(t)) return { intent, confidence: 0.7, language: "unknown", address_text: null };
  }
  return { intent: "other", confidence: 0.3, language: "unknown", address_text: null };
}

/** Classifies a customer's free-text WhatsApp message (any language, incl. Roman Urdu). */
export async function detectIntent(store, { text, context }) {
  return aiJson(store, "intent", {
    system:
      "You classify WhatsApp messages sent by e-commerce customers to a store. Customers write in any language, including Urdu, Roman Urdu, Hindi, Arabic and English, often informally. " +
      `Return one intent from: ${INTENTS.join(", ")}. ` +
      "confirm = they agree/confirm the pending order. cancel = they do not want the order. change_address = they want to change or are sending a delivery address. " +
      "where_is_order = asking about delivery/tracking. opt_out = they ask to stop receiving messages. " +
      "If the message itself contains a delivery address, put it in address_text, else null. language = ISO 639-1 code (use 'ur-Latn' for Roman Urdu).",
    user: `Context: ${context || "none"}\nCustomer message: """${String(text).slice(0, 1500)}"""`,
    schema: obj({
      intent: { type: "string", enum: INTENTS },
      confidence: { type: "number" },
      language: str,
      address_text: nstr,
    }),
    maxTokens: 200,
  });
}

/** Free text address -> structured fields. */
export async function parseAddress(store, text, { country, current } = {}) {
  return aiJson(store, "address_parse", {
    system:
      "You turn a customer's free-text delivery address into structured fields for a courier. Keep the customer's wording for streets and areas, fix obvious spelling of city names, never invent house numbers. " +
      "complete = true only if a courier could find the house (house/flat number, street or block, area, city). List what is missing in `missing`.",
    user: `Country: ${country || "unknown"}\nPrevious address on the order: ${current || "none"}\nCustomer wrote: """${String(text).slice(0, 1000)}"""`,
    schema: obj({
      address1: str,
      address2: nstr,
      landmark: nstr,
      city: nstr,
      province: nstr,
      zip: nstr,
      country_code: nstr,
      complete: { type: "boolean" },
      missing: { type: "array", items: str },
    }),
    maxTokens: 300,
  });
}

/** AI completeness review of an address (good for regions where Google coverage is weak). */
export async function assessAddress(store, addressText, country) {
  return aiJson(store, "address_assess", {
    system:
      "You are a courier dispatcher. Rate how deliverable an address is from 0 to 100 (100 = a rider can find the door without calling). Consider house/flat number, street/block, area/sector, city, landmark.",
    user: `Country: ${country || "unknown"}\nAddress: ${addressText}`,
    schema: obj({ score: { type: "integer" }, missing: { type: "array", items: str }, reason: str }),
    maxTokens: 200,
  });
}

/** Support agent reply with handoff decision. */
export async function agentReply(store, { customerName, orders, history, message, language }) {
  const s = store.settings.ai;
  return aiJson(store, "agent", {
    system:
      `You are the WhatsApp assistant for the online store "${store.name}". Tone: ${s.tone}. ` +
      `Reply ${s.replyLanguage === "auto" ? "in the same language and script the customer used (Roman Urdu if they wrote Roman Urdu)" : `in ${s.replyLanguage}`}. ` +
      "Keep replies short (max 3 sentences), friendly, and only use facts from the store knowledge and order data given. Never invent tracking numbers, prices, policies or delivery dates. " +
      "Set handoff=true when the customer is angry, asks for a human, reports a damaged/wrong item, asks for a refund, or you are not sure. When handoff=true, reply politely that a team member will reply shortly.\n\n" +
      `Store knowledge:\n${s.knowledgeBase || "(none provided)"}`,
    user:
      `Customer: ${customerName || "unknown"}\nPreferred language hint: ${language || "auto"}\n` +
      `Customer's recent orders (JSON): ${JSON.stringify(orders).slice(0, 4000)}\n` +
      `Recent conversation:\n${history}\n\nNew customer message: """${String(message).slice(0, 1500)}"""`,
    schema: obj({ reply: str, handoff: { type: "boolean" }, reason: str }),
    maxTokens: 400,
  });
}

/** Marketing / template copy. Returns several variants. */
export async function writeCopy(store, { brief, kind = "campaign", language = "English", tone, count = 3 }) {
  if (kind === "template") {
    const vars = Object.entries(VARIABLES)
      .filter(([, v]) => !v.media)
      .map(([k, v]) => `${k} (${v.label})`)
      .join("; ");
    return aiJson(store, "copy_template", {
      system:
        "You write WhatsApp Business message templates that Meta will approve. Rules: use {{1}}, {{2}}... placeholders in order; the body must not start or end with a placeholder; no more than one placeholder per ~8 words; max 1024 chars; no newlines inside placeholders; " +
        "UTILITY templates must be about a specific order/transaction with no promotion; MARKETING for offers. Map each placeholder to a variable key from this list: " +
        vars,
      user: `Store: ${store.name}\nLanguage: ${language}\nTone: ${tone || store.settings.ai.tone}\nWrite ${count} variants for: ${brief}`,
      schema: obj({
        variants: {
          type: "array",
          items: obj({
            name: str,
            category: { type: "string", enum: ["UTILITY", "MARKETING"] },
            body: str,
            variables: { type: "array", items: str },
            buttons: { type: "array", items: obj({ type: { type: "string", enum: ["QUICK_REPLY", "URL"] }, text: str }) },
          }),
        },
      }),
      maxTokens: 1500,
    });
  }
  return aiJson(store, "copy_campaign", {
    system:
      "You write short, high-converting WhatsApp marketing messages for an online store. Max 450 characters each, 1-3 fitting emojis, a clear call to action, no ALL CAPS, no false urgency claims you can't back up.",
    user: `Store: ${store.name}\nLanguage: ${language}\nTone: ${tone || store.settings.ai.tone}\nWrite ${count} variants for: ${brief}`,
    schema: obj({ variants: { type: "array", items: obj({ text: str, angle: str }) } }),
    maxTokens: 1200,
  });
}

/** Plain-language summary + recommended actions for owner reports. */
export async function reportInsights(store, metrics) {
  return aiJson(store, "report_insights", {
    system:
      "You are an e-commerce operations analyst. Given store metrics for a period and the previous period, write a 2-sentence summary for the owner (max 300 characters, no line breaks) and up to 3 concrete recommended actions. Mention numbers. Be direct.",
    user: JSON.stringify(metrics).slice(0, 8000),
    schema: obj({ summary: str, actions: { type: "array", items: str } }),
    maxTokens: 500,
  });
}

/** "Ask your data": answer from a precomputed, store-scoped dataset only. */
export async function askData(store, question, dataset) {
  return aiText(store, "ask_data", {
    system:
      "Answer the store owner's question using ONLY the JSON data provided. If the data doesn't contain the answer, say so and suggest which report to open. Be concise, use numbers, use short bullet points when listing.",
    user: `Data: ${JSON.stringify(dataset).slice(0, 12000)}\n\nQuestion: ${question}`,
    maxTokens: 600,
  });
}

/** Optional AI review of suspicious COD orders. */
export async function riskReview(store, order) {
  return aiJson(store, "risk_review", {
    system:
      "You review cash-on-delivery orders for signs of fake or prank orders (gibberish names, fake addresses, joke text, impossible quantities). Return a risk adjustment from -20 to +40 and short reasons.",
    user: JSON.stringify(order).slice(0, 3000),
    schema: obj({ adjustment: { type: "integer" }, reasons: { type: "array", items: str } }),
    maxTokens: 250,
  });
}
