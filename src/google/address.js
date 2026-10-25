import { requestJson } from "../lib/http.js";
import { formatAddress } from "../lib/format.js";
import { config } from "../config.js";
import { sign } from "../lib/crypto.js";

// Regions where the Address Validation API has good coverage. Elsewhere we geocode.
const VALIDATION_REGIONS = new Set(
  "AR AT AU BE BG BR CA CH CL CO CZ DE DK EE ES FI FR GB HR HU IE IN IT LT LU LV MX MY NL NO NZ PL PR PT SE SG SI SK US".split(" ")
);

const GRANULARITY_SCORE = {
  SUB_PREMISE: 100,
  PREMISE: 95,
  PREMISE_PROXIMITY: 85,
  BLOCK: 70,
  ROUTE: 60,
  OTHER: 35,
  GRANULARITY_UNSPECIFIED: 30,
};

const LOCATION_TYPE_SCORE = { ROOFTOP: 92, RANGE_INTERPOLATED: 78, GEOMETRIC_CENTER: 58, APPROXIMATE: 32 };

/** Cheap checks that apply everywhere (useful for countries with informal addresses). */
export function heuristicPenalty(addr) {
  const reasons = [];
  let penalty = 0;
  const line = `${addr?.address1 || ""} ${addr?.address2 || ""}`.trim();
  if (!line) {
    penalty += 60;
    reasons.push("Street address is empty");
  } else {
    if (line.length < 12) {
      penalty += 20;
      reasons.push("Street address is very short");
    }
    if (!/\d/.test(line)) {
      penalty += 12;
      reasons.push("No house/street number");
    }
  }
  if (!addr?.city) {
    penalty += 25;
    reasons.push("City is missing");
  }
  return { penalty, reasons };
}

export async function validateWithGoogle(addr, regionCode, key) {
  const res = await requestJson(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${key}`, {
    method: "POST",
    body: {
      address: {
        regionCode: regionCode || undefined,
        addressLines: [addr.address1, addr.address2].filter(Boolean),
        locality: addr.city || undefined,
        administrativeArea: addr.province || undefined,
        postalCode: addr.zip || undefined,
      },
    },
  });
  if (!res.ok) throw new Error(`Address Validation API error ${res.status}: ${res.json?.error?.message || ""}`);
  const r = res.json.result || {};
  const v = r.verdict || {};
  let score = GRANULARITY_SCORE[v.validationGranularity] ?? 30;
  const reasons = [];
  if (!v.addressComplete) {
    score -= 15;
    reasons.push("Google: address incomplete");
  }
  if (v.hasUnconfirmedComponents) {
    score -= 10;
    reasons.push("Google: some parts could not be confirmed");
  }
  const missing = r.address?.missingComponentTypes || [];
  if (missing.length) reasons.push(`Missing: ${missing.join(", ")}`);
  return {
    source: "google_validation",
    score: Math.max(0, Math.min(100, score)),
    reasons,
    formatted: r.address?.formattedAddress || null,
    lat: r.geocode?.location?.latitude ?? null,
    lng: r.geocode?.location?.longitude ?? null,
    raw: { verdict: v, missing },
  };
}

export async function geocode(addressText, regionCode, key) {
  const params = new URLSearchParams({ address: addressText, key });
  if (regionCode) params.set("region", regionCode.toLowerCase());
  const res = await requestJson(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!res.ok || !["OK", "ZERO_RESULTS"].includes(res.json.status)) {
    throw new Error(`Geocoding API error: ${res.json.status || res.status} ${res.json.error_message || ""}`);
  }
  const top = res.json.results?.[0];
  if (!top) return { source: "google_geocode", score: 15, reasons: ["Google could not find this address"], formatted: null, lat: null, lng: null, raw: {} };
  let score = LOCATION_TYPE_SCORE[top.geometry?.location_type] ?? 30;
  const reasons = [];
  if (top.partial_match) {
    score -= 15;
    reasons.push("Google: only a partial match");
  }
  const types = top.types || [];
  if (types.includes("locality") || types.includes("administrative_area_level_1")) {
    score = Math.min(score, 35);
    reasons.push("Google matched only the city/area");
  }
  return {
    source: "google_geocode",
    score: Math.max(0, Math.min(100, score)),
    reasons,
    formatted: top.formatted_address,
    lat: top.geometry?.location?.lat ?? null,
    lng: top.geometry?.location?.lng ?? null,
    raw: { location_type: top.geometry?.location_type, types, partial: !!top.partial_match },
  };
}

/** Location pin -> structured address. */
export async function reverseGeocode(lat, lng, key) {
  const res = await requestJson(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`);
  const top = res.json.results?.[0];
  if (!top) return null;
  const get = (type, short = false) => {
    const c = top.address_components.find((x) => x.types.includes(type));
    return c ? (short ? c.short_name : c.long_name) : null;
  };
  const streetNumber = get("street_number");
  const route = get("route");
  return {
    address1: [streetNumber, route].filter(Boolean).join(" ") || get("premise") || get("sublocality_level_2") || top.formatted_address.split(",")[0],
    address2: get("sublocality_level_1") || get("neighborhood"),
    city: get("locality") || get("administrative_area_level_2"),
    province: get("administrative_area_level_1"),
    provinceCode: get("administrative_area_level_1", true),
    zip: get("postal_code"),
    country: get("country"),
    countryCode: get("country", true),
    formatted: top.formatted_address,
  };
}

/**
 * Scores an address 0-100 using the best Google API for the region, plus heuristics.
 * Works without a key (heuristics only).
 */
export async function scoreAddress(addr, { regionCode, key, provider = "auto" }) {
  const h = heuristicPenalty(addr);
  const text = formatAddress(addr);
  if (!key || provider === "none") {
    return { source: "heuristic", score: Math.max(0, 85 - h.penalty), reasons: h.reasons, formatted: text, lat: null, lng: null, raw: {} };
  }
  const region = (regionCode || addr.countryCode || "").toUpperCase();
  const useValidation = provider === "validation" || (provider === "auto" && VALIDATION_REGIONS.has(region));
  const g = useValidation ? await validateWithGoogle(addr, region, key) : await geocode(text, region, key);
  return { ...g, score: Math.max(0, g.score - Math.round(h.penalty / 2)), reasons: [...h.reasons, ...g.reasons] };
}

/** Signed URL to our map proxy (keeps the Google key server-side). Meta fetches this for image headers. */
export function mapImageUrl(lat, lng, { zoom = 16, size = "600x320" } = {}) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const v = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)},${zoom},${size}`;
  return `${config.baseUrl}/media/map?v=${encodeURIComponent(v)}&s=${sign(v)}`;
}

export async function fetchStaticMap(v, key, markers) {
  const [lat, lng, zoom, size] = v.split(",");
  const params = new URLSearchParams({ size: size || "600x320", key, scale: "2" });
  if (markers?.length) {
    params.append("markers", `color:red|size:small|${markers.map((m) => `${m[0]},${m[1]}`).join("|")}`);
  } else {
    params.set("center", `${lat},${lng}`);
    params.set("zoom", zoom || "16");
    params.append("markers", `color:red|${lat},${lng}`);
  }
  const res = await requestJson(`https://maps.googleapis.com/maps/api/staticmap?${params}`, { raw: true });
  if (!res.ok) throw new Error(`Static map error ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || "image/png" };
}
