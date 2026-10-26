import { useState } from "react";
import { CheckCircle2, Plus, Star, Trash2, Truck } from "lucide-react";
import { useApi, post, put, del } from "../lib/api.js";
import { Badge, Button, Card, Empty, Field, Input, Modal, Select, Textarea, Toggle, useAction } from "./ui.jsx";

function CourierModal({ storeId, providers, courier, onClose, onDone }) {
  const [provider, setProvider] = useState(courier?.provider || providers[0]?.id);
  const p = providers.find((x) => x.id === provider);
  const [name, setName] = useState(courier?.name || "");
  const [fields, setFields] = useState(courier ? Object.fromEntries(Object.entries(courier.fields).map(([k, v]) => [k, v === "••••••" ? "" : v])) : {});
  const [baseUrl, setBaseUrl] = useState(courier?.baseUrl || "");
  const [isDefault, setIsDefault] = useState(courier?.is_default ?? true);
  const [run, busy] = useAction();
  const save = () =>
    run(
      () => (courier ? put(`/stores/${storeId}/couriers/${courier.id}`, { name, fields, baseUrl, isDefault }) : post(`/stores/${storeId}/couriers`, { provider, name: name || undefined, fields, baseUrl, isDefault })),
      "Courier saved"
    ).then((r) => r && (onDone(), onClose()));
  return (
    <Modal open wide onClose={onClose} title={courier ? `Edit ${courier.name}` : "Add a courier"} footer={<Button loading={busy} onClick={save}>Save</Button>}>
      <div className="space-y-4">
        {!courier && (
          <div className="grid gap-2 sm:grid-cols-3">
            {providers.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setProvider(x.id)}
                className={`rounded-xl p-3 text-left text-sm ring-1 transition ${provider === x.id ? "bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-900/20" : "ring-gray-200 hover:bg-gray-50 dark:ring-gray-700 dark:hover:bg-gray-800/50"}`}
              >
                <div className="font-semibold">{x.name}</div>
                <div className="text-xs text-gray-500">{x.id === "custom" ? "TCS, M&P, Call Courier, BlueEx…" : x.id === "manual" ? "Type or upload tracking numbers" : "Automatic booking & tracking"}</div>
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name shown to customers">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={p?.name} />
          </Field>
          <Field label="API address (advanced)" hint="Leave empty to use the courier's standard API">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="default" />
          </Field>
        </div>
        {p?.fields.map((f) => (
          <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} hint={courier && f.secret ? "Leave empty to keep the saved value" : f.hint}>
            {f.textarea ? (
              <Textarea className="font-mono text-xs" value={fields[f.key] || ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} />
            ) : (
              <Input type={f.secret ? "password" : "text"} value={fields[f.key] || ""} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} autoComplete="off" />
            )}
          </Field>
        ))}
        <Toggle checked={isDefault} onChange={setIsDefault} label="Default courier for this store" hint="Used for automatic booking and the Book button." />
      </div>
    </Modal>
  );
}

export function CouriersTab({ storeId, s, canEdit }) {
  const list = useApi(`/stores/${storeId}/couriers`);
  const providers = useApi("/couriers/providers");
  const [editing, setEditing] = useState(null);
  const [run, busy] = useAction();
  const c = s.get("couriers");
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <Card
        title="Courier accounts"
        icon={Truck}
        actions={canEdit && providers.data && <Button size="sm" onClick={() => setEditing({})}><Plus className="h-4 w-4" /> Add courier</Button>}
      >
        {list.data?.filter((x) => x.active).length === 0 ? (
          <Empty title="No courier yet" action={canEdit && <Button onClick={() => setEditing({})}>Add your first courier</Button>}>
            Connect PostEx, Leopards, Trax or any courier with an API to book parcels in one click and track them automatically.
          </Empty>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {list.data?.filter((x) => x.active).map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="brand-gradient flex h-10 w-10 items-center justify-center rounded-xl text-white"><Truck className="h-5 w-5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold">
                    {x.name} {x.is_default && <Badge tone="green"><Star className="h-3 w-3" /> Default</Badge>}
                  </div>
                  <div className="text-xs text-gray-500">{providers.data?.find((p) => p.id === x.provider)?.name}</div>
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => post(`/stores/${storeId}/couriers/${x.id}/test`), "Connection works ✅")}>
                      <CheckCircle2 className="h-3.5 w-3.5" /> Test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(x)}>Edit</Button>
                    <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => confirm(`Remove ${x.name}?`) && run(() => del(`/stores/${storeId}/couriers/${x.id}`), "Removed").then(list.reload)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Automatic booking" actions={canEdit && <Button size="sm" loading={busy} onClick={() => run(() => s.save(["couriers", "recovery"]), "Saved")}>Save</Button>}>
        <div className="space-y-4">
          <Toggle checked={c.autoBook} onChange={(v) => s.set("couriers.autoBook", v)} label="Book the default courier when a customer confirms" hint="Orders waiting for an advance are booked after it's paid." />
          <Toggle checked={c.skipRisky} onChange={(v) => s.set("couriers.skipRisky", v)} label="Don't auto-book high-risk orders" hint="They stay in Shipments → To book for a person to check." />
          <Toggle checked={c.fulfillInShopify} onChange={(v) => s.set("couriers.fulfillInShopify", v)} label="Mark the order fulfilled in Shopify with the tracking number" />
          <Toggle checked={c.notifyOnBooking} onChange={(v) => s.set("couriers.notifyOnBooking", v)} label="Send the tracking number on WhatsApp after booking" />
          <Field label="Default parcel weight (kg)">
            <Input type="number" step="0.1" min="0.1" value={c.defaultWeightKg} onChange={(e) => s.set("couriers.defaultWeightKg", Number(e.target.value))} />
          </Field>
          <div className="border-t border-gray-100 pt-4 dark:border-gray-800">
            <Toggle checked={s.get("recovery.enabled")} onChange={(v) => s.set("recovery.enabled", v)} label="Failed delivery recovery" hint="When the courier can't deliver, ask the customer on WhatsApp: deliver again, change address or cancel." />
            <Field label="Ask at most this many times per parcel" className="mt-3">
              <Input type="number" min="1" max="5" value={s.get("recovery.maxMessages")} onChange={(e) => s.set("recovery.maxMessages", Number(e.target.value))} />
            </Field>
          </div>
        </div>
      </Card>
      {editing && providers.data && <CourierModal storeId={storeId} providers={providers.data} courier={editing.id ? editing : null} onClose={() => setEditing(null)} onDone={list.reload} />}
    </div>
  );
}

/** Advance payments, fraud, profit costs, upsell, reviews and back-in-stock. */
export function SalesTab({ storeId, s, canEdit }) {
  const [run, busy] = useAction();
  const products = useApi(`/products?storeId=${storeId}&limit=96`);
  const variants = (products.data?.rows || []).flatMap((p) => (p.variants || []).map((v) => ({ value: v.id, label: `${p.title}${v.title && v.title !== "Default Title" ? ` · ${v.title}` : ""}`, image: v.image || p.image_url, price: v.price })));
  const a = s.get("advance");
  const save = (sections) => run(() => s.save(sections), "Saved");
  const SaveBtn = ({ sections }) => canEdit && <Button size="sm" loading={busy} onClick={() => save(sections)}>Save</Button>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Advance payment for COD orders" actions={<SaveBtn sections={["advance"]} />}>
        <div className="space-y-3">
          <Toggle checked={a.enabled} onChange={(v) => s.set("advance.enabled", v)} label="Ask for an advance after the customer confirms" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who pays an advance">
              <Select value={a.mode} onChange={(e) => s.set("advance.mode", e.target.value)} options={[{ value: "risky", label: "Only risky orders" }, { value: "over_amount", label: "Orders above an amount" }, { value: "all_cod", label: "Every COD order" }]} />
            </Field>
            {a.mode === "risky" ? (
              <Field label="Risk score from">
                <Input type="number" value={a.riskThreshold} onChange={(e) => s.set("advance.riskThreshold", Number(e.target.value))} />
              </Field>
            ) : (
              <Field label="Minimum order total">
                <Input type="number" value={a.minTotal} onChange={(e) => s.set("advance.minTotal", Number(e.target.value))} />
              </Field>
            )}
            <Field label="Amount">
              <Select value={a.type} onChange={(e) => s.set("advance.type", e.target.value)} options={[{ value: "fixed", label: "Fixed amount" }, { value: "percent", label: "% of the order" }, { value: "full", label: "Full payment" }]} />
            </Field>
            {a.type !== "full" && (
              <Field label={a.type === "percent" ? "Percent" : "Amount"}>
                <Input type="number" value={a.type === "percent" ? a.percent : a.amount} onChange={(e) => s.set(a.type === "percent" ? "advance.percent" : "advance.amount", Number(e.target.value))} />
              </Field>
            )}
          </div>
          <Field label="How to pay (sent to the customer)">
            <Textarea value={a.instructions} onChange={(e) => s.set("advance.instructions", e.target.value)} />
          </Field>
          <Toggle checked={a.cardLink} onChange={(v) => s.set("advance.cardLink", v)} label="Also send a card payment link" hint="Needs Stripe (STRIPE_SECRET_KEY) on the server. Paid links are marked automatically." />
        </div>
      </Card>
      <Card title="Fraud protection" actions={<SaveBtn sections={["fraud", "risk"]} />}>
        <div className="space-y-3">
          <Toggle checked={s.get("fraud.networkCheck")} onChange={(v) => s.set("fraud.networkCheck", v)} label="Check each number's delivery record across the whole network" hint="Customers who refused parcels at other stores get a higher risk score." />
          <Field label="Orders from blocked numbers">
            <Select value={s.get("fraud.blockAction")} onChange={(e) => s.set("fraud.blockAction", e.target.value)} options={[{ value: "flag", label: "Flag for review (still confirm)" }, { value: "advance", label: "Ask for an advance payment" }, { value: "cancel", label: "Cancel automatically" }]} />
          </Field>
          <Field label="Block a number automatically after this many returns" hint="0 = never">
            <Input type="number" min="0" value={s.get("fraud.autoBlockAfterReturns")} onChange={(e) => s.set("fraud.autoBlockAfterReturns", Number(e.target.value))} />
          </Field>
          <Field label="High risk from score">
            <Input type="number" value={s.get("risk.highThreshold")} onChange={(e) => s.set("risk.highThreshold", Number(e.target.value))} />
          </Field>
        </div>
      </Card>
      <Card title="Upsell after confirmation" actions={<SaveBtn sections={["upsell"]} />}>
        <div className="space-y-3">
          <Toggle checked={s.get("upsell.enabled")} onChange={(v) => s.set("upsell.enabled", v)} label="Offer one extra product right after the customer confirms" hint="If they tap Yes, it's added to the same Shopify order." />
          <Field label="Product to offer">
            <Select value={s.get("upsell.variantId") || ""} onChange={(e) => s.set("upsell.variantId", e.target.value ? Number(e.target.value) : null)}>
              <option value="">Choose a product…</option>
              {variants.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Discount %" hint="Applied to the added item">
              <Input type="number" min="0" max="90" value={s.get("upsell.discountPercent") || 0} onChange={(e) => s.set("upsell.discountPercent", Number(e.target.value))} />
            </Field>
            <Field label="Image (optional)">
              <Input value={s.get("upsell.imageUrl") || ""} onChange={(e) => s.set("upsell.imageUrl", e.target.value)} placeholder="product photo" />
            </Field>
          </div>
          <Field label="Message" hint="{{product}} and {{price}} are filled in">
            <Input value={s.get("upsell.text")} onChange={(e) => s.set("upsell.text", e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card title="Reviews & back in stock" actions={<SaveBtn sections={["reviews", "backInStock"]} />}>
        <div className="space-y-3">
          <Toggle checked={s.get("reviews.enabled")} onChange={(v) => s.set("reviews.enabled", v)} label="Collect reviews on WhatsApp after delivery" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Days after delivery">
              <Input type="number" min="0" value={s.get("reviews.delayDays")} onChange={(e) => s.set("reviews.delayDays", Number(e.target.value))} />
            </Field>
            <Field label="Auto-publish from rating">
              <Select value={s.get("reviews.autoPublishMin")} onChange={(e) => s.set("reviews.autoPublishMin", Number(e.target.value))} options={[{ value: 4, label: "4 stars" }, { value: 5, label: "5 stars only" }, { value: 6, label: "Never (review by hand)" }]} />
            </Field>
          </div>
          <Toggle checked={s.get("reviews.askPhoto")} onChange={(v) => s.set("reviews.askPhoto", v)} label="Ask for a photo and a few words" />
          <div className="border-t border-gray-100 pt-3 dark:border-gray-800">
            <Toggle checked={s.get("backInStock.enabled")} onChange={(v) => s.set("backInStock.enabled", v)} label="Back-in-stock WhatsApp alerts" hint="People who signed up get a message the moment Shopify stock goes above 0." />
          </div>
        </div>
      </Card>
      <Card title="Costs for the profit report" actions={<SaveBtn sections={["profit"]} />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Courier fee per parcel" hint="Used when the courier doesn't report its fee">
            <Input type="number" value={s.get("profit.shippingCost")} onChange={(e) => s.set("profit.shippingCost", Number(e.target.value))} />
          </Field>
          <Field label="Extra cost per returned parcel">
            <Input type="number" value={s.get("profit.returnCost")} onChange={(e) => s.set("profit.returnCost", Number(e.target.value))} />
          </Field>
          <Field label="COD collection fee %">
            <Input type="number" step="0.1" value={s.get("profit.codFeePercent")} onChange={(e) => s.set("profit.codFeePercent", Number(e.target.value))} />
          </Field>
          <Field label="Packaging per parcel">
            <Input type="number" value={s.get("profit.packagingCost")} onChange={(e) => s.set("profit.packagingCost", Number(e.target.value))} />
          </Field>
          <Field label="Other fees % of revenue" hint="Payment gateway, Shopify, tax…">
            <Input type="number" step="0.1" value={s.get("profit.otherPercent")} onChange={(e) => s.set("profit.otherPercent", Number(e.target.value))} />
          </Field>
        </div>
      </Card>
    </div>
  );
}
