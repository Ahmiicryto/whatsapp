/**
 * Any courier with an HTTP API (TCS, M&P, Call Courier, BlueEx, Swyft, Rider, DHL…): the merchant
 * describes the booking and tracking requests once, with {{placeholders}}, and where to read the answers.
 */
import { requestJson } from "../lib/http.js";
import { courierError, fillTemplate, pick } from "./common.js";

function headersOf(c) {
  try {
    return JSON.parse(fillTemplate(c.creds.headers || "{}", c.creds, { json: true }));
  } catch {
    throw courierError(c.row.name, "the Headers field is not valid JSON");
  }
}

export const custom = {
  id: "custom",
  name: "Custom courier (any API)",
  fields: [
    { key: "headers", label: "Headers (JSON)", secret: true, textarea: true, hint: 'e.g. {"Authorization": "Bearer YOUR_KEY"}' },
    { key: "bookUrl", label: "Booking URL", setting: true, required: true, hint: "POST endpoint that creates a shipment" },
    { key: "bookBody", label: "Booking body (JSON with placeholders)", setting: true, textarea: true, required: true, hint: "Placeholders: {{ref}} {{name}} {{phone}} {{phone_local}} {{address}} {{city}} {{cod}} {{pieces}} {{weight_kg}} {{description}} {{email}} {{notes}}" },
    { key: "trackingPath", label: "Tracking number in the response", setting: true, required: true, hint: "Dot path, e.g. data.tracking_number" },
    { key: "trackUrl", label: "Tracking API URL", setting: true, hint: "GET URL with {{tracking}}, e.g. https://api.courier.com/track/{{tracking}}" },
    { key: "statusPath", label: "Status in the tracking response", setting: true, hint: "Dot path, e.g. data.status" },
    { key: "publicTrackingUrl", label: "Customer tracking page", setting: true, hint: "Link sent to customers, with {{tracking}}" },
  ],
  trackingUrl: (tn, c) => (c?.settings.publicTrackingUrl ? fillTemplate(c.settings.publicTrackingUrl, { tracking: tn }) : null),

  async book(c, s) {
    const vars = { ...s.vars };
    let body;
    try {
      body = JSON.parse(fillTemplate(c.settings.bookBody, vars, { json: true }));
    } catch {
      throw courierError(c.row.name, "the booking body is not valid JSON after filling placeholders");
    }
    const res = await requestJson(c.settings.bookUrl, { method: "POST", headers: headersOf(c), body });
    const tn = pick(res.json, c.settings.trackingPath);
    if (!res.ok || !tn) throw courierError(c.row.name, `booking failed (HTTP ${res.status}): ${JSON.stringify(res.json).slice(0, 200)}`, res);
    return { trackingNumber: String(tn), raw: res.json };
  },

  async track(c, trackingNumber) {
    if (!c.settings.trackUrl) return null; // statuses are updated by hand or CSV
    const res = await requestJson(fillTemplate(c.settings.trackUrl, { tracking: trackingNumber }), { headers: headersOf(c) });
    if (!res.ok) throw courierError(c.row.name, `tracking failed (HTTP ${res.status})`, res);
    return { statusRaw: pick(res.json, c.settings.statusPath || "status"), events: [] };
  },
};
