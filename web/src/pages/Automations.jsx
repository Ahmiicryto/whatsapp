import { useSingleStore } from "../lib/session.jsx";
import { useStoreSettings } from "../lib/useStoreSettings.js";
import { Card, Button, PageHeader, Field, Input, Select, Textarea, Toggle, Loading, Empty, useAction } from "../components/ui.jsx";

function Num({ s, path, label, hint, min = 0, step = 1 }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" min={min} step={step} value={s.get(path) ?? ""} onChange={(e) => s.set(path, e.target.value === "" ? 0 : Number(e.target.value))} />
    </Field>
  );
}

function Flag({ s, path, label, hint }) {
  return <Toggle checked={!!s.get(path)} onChange={(v) => s.set(path, v)} label={label} hint={hint} />;
}

function Section({ title, description, children, onSave, busy }) {
  return (
    <Card title={title} actions={<Button size="sm" loading={busy} onClick={onSave}>Save</Button>}>
      {description && <p className="mb-3 text-sm text-gray-500">{description}</p>}
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

export default function Automations() {
  const { store } = useSingleStore();
  const s = useStoreSettings(store?.id);
  const [run, busy] = useAction();
  if (!store) return <Empty title="Connect a store first" />;
  if (!s.draft) return <Loading />;
  const save = (sections) => () => run(() => s.save(sections), "Saved");
  const steps = s.get("marketing.abandonedCart.steps") || [];

  return (
    <div className="space-y-4">
      <PageHeader title="Automations" subtitle={`What happens automatically for ${store.name}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="✅ Order confirmation" description="Sent when a new order arrives, with product image, items, price, address and Confirm / Change address / Cancel buttons." onSave={save(["confirmation"])} busy={busy}>
          <Flag s={s} path="confirmation.enabled" label="Send WhatsApp confirmation for new orders" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Which orders">
              <Select value={s.get("confirmation.scope")} onChange={(e) => s.set("confirmation.scope", e.target.value)} options={[{ value: "cod", label: "Cash on delivery only" }, { value: "all", label: "All orders" }, { value: "prepaid", label: "Prepaid only" }]} />
            </Field>
            <Num s={s} path="confirmation.delayMinutes" label="Send after (minutes)" />
            <Num s={s} path="confirmation.reminderHours" label="Reminder after (hours)" />
            <Num s={s} path="confirmation.noResponseHours" label="Mark “no response” after (hours)" />
          </div>
          <Flag s={s} path="confirmation.reminderEnabled" label="Send a reminder if the customer hasn't replied" />
          <Flag s={s} path="confirmation.askCancelReason" label="Ask for a reason before cancelling" />
          <Flag s={s} path="confirmation.autoCancelInShopify" label="Cancel the order in Shopify when the customer cancels" hint="Off = only tag the order so your team decides." />
          <Flag s={s} path="confirmation.sendProductImages" label="Send product photos after confirmation" />
          <Field label="Thank-you message" hint="{{name}} and {{order}} are replaced">
            <Textarea value={s.get("confirmation.thankYouText")} onChange={(e) => s.set("confirmation.thankYouText", e.target.value)} />
          </Field>
          <Field label="Cancellation message">
            <Textarea value={s.get("confirmation.cancelText")} onChange={(e) => s.set("confirmation.cancelText", e.target.value)} />
          </Field>
        </Section>

        <Section title="📍 Address verification" description="Google scores every address (plus AI for informal addresses). Weak ones are confirmed with the customer, who can share a location pin or type a new address." onSave={save(["address"])} busy={busy}>
          <Flag s={s} path="address.enabled" label="Check every new order's address" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Google API">
              <Select value={s.get("address.provider")} onChange={(e) => s.set("address.provider", e.target.value)} options={[{ value: "auto", label: "Automatic by country" }, { value: "validation", label: "Address Validation API" }, { value: "geocoding", label: "Geocoding API" }, { value: "none", label: "No Google (rules + AI)" }]} />
            </Field>
            <Num s={s} path="address.verifyThreshold" label="Verified at score ≥" />
            <Num s={s} path="address.updateThreshold" label="Ask for new address below" />
          </div>
          <Flag s={s} path="address.askAfterConfirm" label="Ask the customer to confirm weak addresses after they confirm the order" />
          <Flag s={s} path="address.useAi" label="Use AI to read typed addresses and judge completeness" />
          <Flag s={s} path="address.writeBackToShopify" label="Save corrected addresses to the Shopify order" />
          <Field label="Cities you don't deliver to" hint="Comma separated. Orders there get score 0 and the address-issue tag.">
            <Input value={(s.get("address.blockedCities") || []).join(", ")} onChange={(e) => s.set("address.blockedCities", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />
          </Field>
        </Section>

        <Section title="🚚 Tracking updates" onSave={save(["tracking"])} busy={busy}>
          <Flag s={s} path="tracking.enabled" label="Send tracking number and link when an order ships" />
          <Flag s={s} path="tracking.outForDelivery" label="Send “out for delivery” message" />
          <Flag s={s} path="tracking.delivered" label="Send “delivered” message" />
          <Flag s={s} path="tracking.reviewRequest.enabled" label="Ask for a review after delivery" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Num s={s} path="tracking.reviewRequest.delayDays" label="Days after delivery" />
            <Field label="Review page URL">
              <Input value={s.get("tracking.reviewRequest.url")} onChange={(e) => s.set("tracking.reviewRequest.url", e.target.value)} placeholder="https://…" />
            </Field>
          </div>
        </Section>

        <Section title="🛒 Abandoned cart recovery" description="Reminds opted-in shoppers who left checkout. The last step can include a unique discount code." onSave={save(["marketing"])} busy={busy}>
          <Flag s={s} path="marketing.abandonedCart.enabled" label="Send abandoned cart reminders" />
          {steps.map((st, i) => (
            <div key={i} className="flex items-end gap-2">
              <Field label={`Step ${i + 1}: minutes after checkout`} className="flex-1">
                <Input type="number" value={st.delayMinutes} onChange={(e) => s.set("marketing.abandonedCart.steps", steps.map((x, j) => (j === i ? { ...x, delayMinutes: Number(e.target.value) } : x)))} />
              </Field>
              <Field label="Discount %" className="w-28">
                <Input type="number" value={st.discountPercent || ""} onChange={(e) => s.set("marketing.abandonedCart.steps", steps.map((x, j) => (j === i ? { ...x, discountPercent: Number(e.target.value) || undefined } : x)))} />
              </Field>
              <Button variant="ghost" onClick={() => s.set("marketing.abandonedCart.steps", steps.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button size="sm" variant="secondary" disabled={steps.length >= 4} onClick={() => s.set("marketing.abandonedCart.steps", [...steps, { delayMinutes: (steps.at(-1)?.delayMinutes || 0) + 360 }])}>
            + Add step
          </Button>
        </Section>

        <Section title="💝 Win-back & upsell" onSave={save(["marketing"])} busy={busy}>
          <Flag s={s} path="marketing.winBack.enabled" label="Win back customers who haven't ordered in a while" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Num s={s} path="marketing.winBack.days" label="After days without order" />
            <Num s={s} path="marketing.winBack.discountPercent" label="Discount %" />
            <Num s={s} path="marketing.winBack.validDays" label="Code valid (days)" />
          </div>
          <Flag s={s} path="marketing.codToPrepaid.enabled" label="Offer prepaid payment after a COD order is confirmed" />
          <Field label="Prepaid offer text" hint="{{name}}, {{order}}, {{link}}">
            <Textarea value={s.get("marketing.codToPrepaid.text")} onChange={(e) => s.set("marketing.codToPrepaid.text", e.target.value)} placeholder="Pay now for {{order}} and get free delivery: {{link}}" />
          </Field>
          <Field label="Payment link">
            <Input value={s.get("marketing.codToPrepaid.link")} onChange={(e) => s.set("marketing.codToPrepaid.link", e.target.value)} />
          </Field>
          <Flag s={s} path="marketing.optInAfterConfirm" label="Ask customers to opt in to offers after they confirm" />
          <Flag s={s} path="marketing.requireOptIn" label="Only send marketing to opted-in customers (recommended by WhatsApp policy)" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Num s={s} path="marketing.messagesPerSecond" label="Campaign speed (messages/second)" min={1} />
            <Num s={s} path="marketing.attributionDays" label="Attribute orders within (days)" min={1} />
          </div>
        </Section>

        <Section title="🛡️ Risk & quiet hours" onSave={save(["risk", "quietHours", "alerts"])} busy={busy}>
          <Flag s={s} path="risk.enabled" label="Score orders for fake / risky COD signals" />
          <Num s={s} path="risk.highThreshold" label="High risk at score ≥" />
          <Flag s={s} path="risk.useAi" label="Ask AI to review suspicious orders" />
          <Flag s={s} path="quietHours.enabled" label="Don't send reminders or marketing during quiet hours" hint="Order confirmations and replies still go out." />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Quiet from">
              <Input type="time" value={s.get("quietHours.start")} onChange={(e) => s.set("quietHours.start", e.target.value)} />
            </Field>
            <Field label="Quiet until">
              <Input type="time" value={s.get("quietHours.end")} onChange={(e) => s.set("quietHours.end", e.target.value)} />
            </Field>
          </div>
          <div className="text-xs font-medium uppercase text-gray-500">Owner alerts</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Num s={s} path="alerts.highValueOrder" label="High value order ≥ (0 = off)" />
            <Num s={s} path="alerts.failedSpike" label="Failed messages per hour ≥" />
            <Num s={s} path="alerts.lowConfirmationRate" label="Confirmation rate below % (0 = off)" />
          </div>
          <Flag s={s} path="alerts.highRisk" label="Alert on high-risk orders" />
          <Flag s={s} path="alerts.qualityDrop" label="Alert when WhatsApp number quality drops" />
        </Section>
      </div>
    </div>
  );
}
