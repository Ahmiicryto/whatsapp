/** Trax (Sonic) merchant API. Credentials: API key + pickup address ID from the Trax portal. */
import { requestJson } from "../lib/http.js";
import { courierError, localPhone, matchCity } from "./common.js";

const BASE = "https://sonic.pk/api";
const auth = (c) => ({ Authorization: c.creds.apiKey });

async function cities(c) {
  if (c.settings.cities?.length) return c.settings.cities;
  const res = await requestJson(`${c.settings.baseUrl || BASE}/cities`, { headers: auth(c) });
  const list = (res.json?.cities || []).map((x) => ({ id: x.id, name: x.name }));
  if (!list.length) throw courierError("Trax", res.json?.message || "could not load the city list (check the API key)", res);
  c.settings.cities = list;
  await c.saveSettings?.();
  return list;
}

export const trax = {
  id: "trax",
  name: "Trax",
  fields: [
    { key: "apiKey", label: "API key", secret: true, required: true },
    { key: "pickupAddressId", label: "Pickup address ID", required: true },
  ],
  trackingUrl: (tn) => `https://trax.pk/tracking/?tracking_number=${encodeURIComponent(tn)}`,

  async book(c, s) {
    const city = matchCity(await cities(c), s.city);
    if (!city) throw courierError("Trax", `city "${s.city}" is not served by Trax`);
    const res = await requestJson(`${c.settings.baseUrl || BASE}/shipment/book`, {
      method: "POST",
      headers: auth(c),
      body: {
        service_type_id: 1,
        pickup_address_id: Number(c.creds.pickupAddressId),
        information_display: 1,
        consignee_city_id: city.id,
        consignee_name: s.name,
        consignee_address: s.address,
        consignee_phone_number_1: localPhone(s.phone),
        consignee_email_address: s.email || "noreply@example.com",
        order_id: s.ref,
        item_product_type_id: 1,
        item_description: s.description.slice(0, 250),
        item_quantity: s.pieces,
        item_insurance: 0,
        pickup_date: new Date().toISOString().slice(0, 10),
        special_instructions: s.notes || "",
        estimated_weight: s.weightKg,
        shipping_mode_id: 1,
        amount: Math.round(s.codAmount),
        payment_mode_id: s.codAmount > 0 ? 1 : 4,
        charges_mode_id: 4,
      },
    });
    if (Number(res.json?.status) !== 0 || !res.json?.tracking_number) throw courierError("Trax", res.json?.message || `booking failed (HTTP ${res.status})`, res);
    return { trackingNumber: String(res.json.tracking_number), raw: res.json };
  },

  async track(c, trackingNumber) {
    const res = await requestJson(`${c.settings.baseUrl || BASE}/shipment/track?tracking_number=${encodeURIComponent(trackingNumber)}&type=0`, { headers: auth(c) });
    const d = res.json?.details;
    if (Number(res.json?.status) !== 0 || !d) throw courierError("Trax", res.json?.message || "tracking failed", res);
    const events = (d.tracking_history || []).map((e) => ({ status: e.status, at: e.date_time }));
    return { statusRaw: d.current_status || events[0]?.status, events };
  },

  async test(c) {
    c.settings.cities = null;
    return { ok: true, cities: (await cities(c)).length };
  },
};
