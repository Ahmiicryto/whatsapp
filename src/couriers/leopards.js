/** Leopards Courier merchant API. Credentials: API key + API password from the Leopards merchant portal. */
import { requestJson } from "../lib/http.js";
import { courierError, localPhone, matchCity } from "./common.js";

const BASE = "https://merchantapi.leopardscourier.com/api";

async function cities(c) {
  if (c.settings.cities?.length) return c.settings.cities;
  const res = await requestJson(`${c.settings.baseUrl || BASE}/getAllCities/format/json/`, { method: "POST", body: { api_key: c.creds.apiKey, api_password: c.creds.apiPassword } });
  const list = (res.json?.city_list || []).map((x) => ({ id: x.id, name: x.name }));
  if (!list.length) throw courierError("Leopards", res.json?.error || "could not load the city list (check API key/password)", res);
  c.settings.cities = list;
  await c.saveSettings?.();
  return list;
}

export const leopards = {
  id: "leopards",
  name: "Leopards Courier",
  fields: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "apiPassword", label: "API password", secret: true, required: true },
  ],
  trackingUrl: (tn) => `https://www.leopardscourier.com/leopards-tracking?cn=${encodeURIComponent(tn)}`,

  async book(c, s) {
    const city = matchCity(await cities(c), s.city);
    if (!city) throw courierError("Leopards", `city "${s.city}" is not served by Leopards`);
    const res = await requestJson(`${c.settings.baseUrl || BASE}/bookPacket/format/json/`, {
      method: "POST",
      body: {
        api_key: c.creds.apiKey,
        api_password: c.creds.apiPassword,
        booked_packet_weight: Math.max(1, Math.round(s.weightKg * 1000)),
        booked_packet_no_piece: s.pieces,
        booked_packet_collect_amount: Math.round(s.codAmount),
        booked_packet_order_id: s.ref,
        origin_city: "self",
        destination_city: city.id,
        shipment_name_eng: "self",
        shipment_email: "self",
        shipment_phone: "self",
        shipment_address: "self",
        consignment_name_eng: s.name,
        consignment_email: s.email || "",
        consignment_phone: localPhone(s.phone),
        consignment_address: s.address,
        special_instructions: (s.notes || s.description).slice(0, 250),
      },
    });
    if (Number(res.json?.status) !== 1 || !res.json?.track_number) throw courierError("Leopards", res.json?.error || `booking failed (HTTP ${res.status})`, res);
    return { trackingNumber: String(res.json.track_number), labelUrl: res.json.slip_link || null, raw: res.json };
  },

  async track(c, trackingNumber) {
    const res = await requestJson(`${c.settings.baseUrl || BASE}/trackBookedPacket/format/json/`, {
      method: "POST",
      body: { api_key: c.creds.apiKey, api_password: c.creds.apiPassword, track_numbers: trackingNumber },
    });
    const p = res.json?.packet_list?.[0];
    if (!p) throw courierError("Leopards", res.json?.error || "tracking failed", res);
    const events = (p["Tracking Detail"] || p.tracking_detail || []).map((e) => ({ status: e.Status || e.status, at: e.Activity_datetime || e.activity_date }));
    return { statusRaw: p.booked_packet_status, events, fee: p.booking_charges ? Number(p.booking_charges) : undefined };
  },

  async test(c) {
    c.settings.cities = null;
    return { ok: true, cities: (await cities(c)).length };
  },
};
