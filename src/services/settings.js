/**
 * Every store setting with its default. Stored settings are deep-merged over these,
 * so new options added later get sensible values for existing stores.
 */
export const DEFAULT_SETTINGS = {
  displayName: "",
  language: "en",
  defaultProductImage: "",
  confirmation: {
    enabled: true,
    scope: "cod", // all | cod | prepaid
    delayMinutes: 1,
    reminderEnabled: true,
    reminderHours: 6,
    noResponseHours: 24,
    autoCancelInShopify: false,
    askCancelReason: true,
    thankYouText: "Thank you {{name}}! Your order {{order}} is confirmed ✅ We will share tracking details as soon as it ships.",
    cancelText: "Your order {{order}} has been cancelled. We hope to serve you again soon.",
    sendProductImages: false,
  },
  tags: {
    sent: "wa-sent",
    confirmed: "wa-confirmed",
    cancelled: "wa-cancelled",
    noResponse: "wa-no-response",
    noPhone: "wa-no-phone",
    failed: "wa-failed",
    trackingSent: "wa-tracking-sent",
    delivered: "wa-delivered",
    addressVerified: "address-verified",
    addressUpdated: "address-updated",
    addressIssue: "address-issue",
    riskHigh: "risk-high",
  },
  address: {
    enabled: true,
    provider: "auto", // auto | validation | geocoding | none
    verifyThreshold: 80,
    updateThreshold: 50,
    askAfterConfirm: true,
    useAi: true,
    writeBackToShopify: true,
    blockedCities: [],
  },
  tracking: {
    enabled: true,
    outForDelivery: true,
    delivered: true,
    reviewRequest: { enabled: false, delayDays: 3, url: "" },
  },
  ai: {
    enabled: true,
    provider: "openai", // openai | gemini
    model: "",
    intent: true,
    agent: true,
    voiceNotes: true,
    tone: "friendly and professional",
    replyLanguage: "auto", // auto = reply in the customer's language
    knowledgeBase: "",
    minConfidence: 0.6,
    humanPauseHours: 12,
  },
  quietHours: { enabled: false, start: "22:00", end: "09:00" },
  risk: { enabled: true, highThreshold: 60, useAi: false },
  marketing: {
    requireOptIn: true,
    optInAfterConfirm: true,
    messagesPerSecond: 10,
    attributionDays: 7,
    abandonedCart: {
      enabled: false,
      steps: [{ delayMinutes: 30 }, { delayMinutes: 360 }, { delayMinutes: 1440, discountPercent: 10 }],
    },
    winBack: { enabled: false, days: 60, discountPercent: 10, validDays: 7 },
    codToPrepaid: { enabled: false, text: "", link: "" },
  },
  reports: { daily: true, time: "21:00", weekly: false, monthly: false, aiSummary: true },
  alerts: { highValueOrder: 0, highRisk: true, failedSpike: 10, qualityDrop: true, lowConfirmationRate: 0 },
  pricing: { currency: "USD", marketing: 0.05, utility: 0.01, authentication: 0.01, service: 0 },
  bundles: { enabled: false, removeBundleLine: false, rules: [] }, // rules: [{bundleSku, components:[{sku, quantity}]}]
};

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isObj(override)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function resolveSettings(stored) {
  return deepMerge(DEFAULT_SETTINGS, stored || {});
}

/** Fill {{name}}-style placeholders in free text settings. */
export function fillText(text, vars) {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ""));
}
