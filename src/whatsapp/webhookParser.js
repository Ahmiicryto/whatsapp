import { hmacHex, safeEqual } from "../lib/crypto.js";

export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !rawBody) return false;
  return safeEqual(`sha256=${hmacHex(appSecret, rawBody)}`, String(header));
}

/** Flattens a Cloud API webhook body into simple events. */
export function parseWebhook(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    const wabaId = entry.id;
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (change.field === "messages") {
        const phoneNumberId = v.metadata?.phone_number_id;
        const contacts = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages || []) {
          const ev = {
            type: "message",
            wabaId,
            phoneNumberId,
            from: m.from,
            wamid: m.id,
            timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
            profileName: contacts[m.from] || null,
            kind: m.type,
            contextId: m.context?.id || null,
            text: null,
            payload: null,
            // Click-to-WhatsApp ad that started the chat (for ad attribution)
            referral: m.referral ? { source_url: m.referral.source_url || null, source_id: m.referral.source_id || null, source_type: m.referral.source_type || null, headline: m.referral.headline || null, ctwa_clid: m.referral.ctwa_clid || null } : null,
          };
          switch (m.type) {
            case "text":
              ev.text = m.text?.body || "";
              break;
            case "button": // quick reply on a template
              ev.text = m.button?.text || "";
              ev.payload = m.button?.payload || null;
              break;
            case "interactive": {
              const r = m.interactive?.button_reply || m.interactive?.list_reply;
              if (r) {
                ev.text = r.title || "";
                ev.payload = r.id || null;
              } else if (m.interactive?.nfm_reply) {
                ev.kind = "flow";
                ev.text = m.interactive.nfm_reply.body || "";
                try {
                  ev.flowResponse = JSON.parse(m.interactive.nfm_reply.response_json || "{}");
                } catch {
                  ev.flowResponse = {};
                }
              }
              break;
            }
            case "location":
              ev.location = {
                lat: m.location?.latitude,
                lng: m.location?.longitude,
                name: m.location?.name || null,
                address: m.location?.address || null,
              };
              break;
            case "audio":
            case "voice":
              ev.kind = "audio";
              ev.media = { id: m.audio?.id || m.voice?.id, mime: m.audio?.mime_type || m.voice?.mime_type };
              break;
            case "image":
            case "video":
            case "document":
            case "sticker":
              ev.media = { id: m[m.type]?.id, mime: m[m.type]?.mime_type };
              ev.text = m[m.type]?.caption || "";
              break;
            case "reaction":
              ev.text = m.reaction?.emoji || "";
              break;
            default:
              ev.text = "";
          }
          events.push(ev);
        }
        for (const s of v.statuses || []) {
          events.push({
            type: "status",
            wabaId,
            phoneNumberId,
            wamid: s.id,
            status: s.status, // sent | delivered | read | failed
            recipient: s.recipient_id,
            timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
            category: s.pricing?.category || s.conversation?.origin?.type || null,
            errors: s.errors || [],
          });
        }
      } else if (change.field === "message_template_status_update") {
        events.push({
          type: "template_status",
          wabaId,
          templateId: String(v.message_template_id || ""),
          name: v.message_template_name,
          language: v.message_template_language,
          event: v.event, // APPROVED | REJECTED | PAUSED | DISABLED ...
          reason: v.reason || null,
        });
      } else if (change.field === "phone_number_quality_update") {
        events.push({
          type: "quality",
          wabaId,
          displayNumber: v.display_phone_number,
          event: v.event, // FLAGGED | UNFLAGGED | UPGRADE | DOWNGRADE
          limit: v.current_limit,
        });
      }
    }
  }
  return events;
}
