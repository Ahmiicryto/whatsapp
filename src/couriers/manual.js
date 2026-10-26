/** No API: the merchant types or uploads tracking numbers and statuses. */
export const manual = {
  id: "manual",
  name: "Manual (any courier)",
  fields: [{ key: "publicTrackingUrl", label: "Customer tracking page", setting: true, hint: "Optional link with {{tracking}}" }],
  trackingUrl: (tn, c) => (c?.settings.publicTrackingUrl ? c.settings.publicTrackingUrl.replace("{{tracking}}", encodeURIComponent(tn)) : null),
  async book(_c, s) {
    return { trackingNumber: s.trackingNumber || null, raw: null };
  },
  async track() {
    return null;
  },
};
