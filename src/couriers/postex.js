/** PostEx (Pakistan) merchant API. Credentials: token from PostEx merchant portal → Integration. */
import { requestJson } from "../lib/http.js";
import { courierError, localPhone } from "./common.js";

const BASE = "https://api.postex.pk/services/integration/api";

export const postex = {
  id: "postex",
  name: "PostEx",
  fields: [
    { key: "token", label: "API token", secret: true, required: true, hint: "PostEx merchant portal → Integration → API token" },
    { key: "pickupAddressCode", label: "Pickup address code", hint: "Optional. From PostEx → Pickup addresses" },
  ],
  trackingUrl: (tn) => `https://postex.pk/tracking?cn=${encodeURIComponent(tn)}`,

  async book(c, s) {
    const base = c.settings.baseUrl || BASE;
    const body = {
      orderRefNumber: s.ref,
      invoicePayment: Math.round(s.codAmount),
      orderDetail: s.description.slice(0, 250),
      customerName: s.name,
      customerPhone: localPhone(s.phone),
      deliveryAddress: s.address,
      cityName: s.city,
      invoiceDivision: 1,
      items: s.pieces,
      orderType: "Normal",
      transactionNotes: s.notes || "",
      ...(c.creds.pickupAddressCode ? { pickupAddressCode: c.creds.pickupAddressCode } : {}),
    };
    const res = await requestJson(`${base}/order/v3/create-order`, { method: "POST", headers: { token: c.creds.token }, body });
    const tn = res.json?.dist?.trackingNumber;
    if (!res.ok || !tn) throw courierError("PostEx", res.json?.statusMessage || `booking failed (HTTP ${res.status})`, res);
    return { trackingNumber: tn, raw: res.json };
  },

  async track(c, trackingNumber) {
    const base = c.settings.baseUrl || BASE;
    const res = await requestJson(`${base}/order/v1/track-order/${encodeURIComponent(trackingNumber)}`, { headers: { token: c.creds.token } });
    const d = res.json?.dist;
    if (!res.ok || !d) throw courierError("PostEx", res.json?.statusMessage || `tracking failed (HTTP ${res.status})`, res);
    const history = (d.transactionStatusHistory || []).map((h) => ({ status: h.transactionStatusMessage, at: h.updatedAt || h.modifiedDatetime }));
    return { statusRaw: d.transactionStatus || history[history.length - 1]?.status, events: history };
  },

  async test(c) {
    const base = c.settings.baseUrl || BASE;
    const res = await requestJson(`${base}/order/v2/get-operational-city`, { headers: { token: c.creds.token } });
    if (!res.ok) throw courierError("PostEx", res.json?.statusMessage || "token rejected", res);
    return { ok: true, cities: (res.json?.dist || []).length };
  },
};
