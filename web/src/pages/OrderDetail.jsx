import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, dateTime, STATUS_LABEL, STATUS_TONE, ADDRESS_LABEL, ADDRESS_TONE } from "../lib/format.js";
import { Card, Badge, Button, Loading, ErrorBox, Modal, Field, Input, useAction } from "../components/ui.jsx";
import { ShipmentCard, AdvanceCard, ReputationBadge } from "../components/ShipmentPanel.jsx";

const MSG_TONE = { read: "blue", delivered: "green", sent: "gray", failed: "red", received: "purple", queued: "gray" };

export function MessageTimeline({ messages }) {
  if (!messages.length) return <div className="py-6 text-center text-sm text-gray-500">No messages yet</div>;
  return (
    <div className="space-y-2">
      {messages.map((m) => (
        <div key={m.id} className={m.direction === "in" ? "flex justify-start" : "flex justify-end"}>
          <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm ${m.direction === "in" ? "bg-white dark:bg-gray-800" : "bg-[#d9fdd3] dark:bg-[#005c4b]"}`}>
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-300">
              <span className="font-medium">{m.kind.replace(/_/g, " ")}</span>
              {m.template_name && <span>· {m.template_name}</span>}
              {m.ai_generated && <Badge tone="purple">AI</Badge>}
            </div>
            <div className="whitespace-pre-wrap break-words">{m.body}</div>
            <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-gray-500 dark:text-gray-300">
              {dateTime(m.created_at)}
              {m.direction === "out" && <Badge tone={MSG_TONE[m.status]}>{m.status}</Badge>}
            </div>
            {m.error_text && <div className="mt-1 text-xs text-red-600">{m.error_text}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function OrderDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { data, error, reload } = useApi(`/orders/${id}`, { interval: 20000 });
  const [run, busy] = useAction();
  const [editAddr, setEditAddr] = useState(null);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { order: o, items, messages, fulfillments, addressChecks, customer, conversation } = data;
  const act = (action, extra = {}, msg = "Done") => run(() => post(`/orders/${o.id}/actions`, { action, ...extra }), msg).then(() => setTimeout(reload, 800));
  const a = o.shipping_address || {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/orders" className="text-sm text-gray-500 hover:underline">
            ← Orders
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
            {o.name}
            <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
            {o.is_cod ? <Badge tone="amber">COD</Badge> : <Badge tone="green">Prepaid</Badge>}
            {o.needs_attention && <Badge tone="red">Needs attention</Badge>}
          </h1>
          <div className="text-sm text-gray-500">
            {data.store.name} · {dateTime(o.shopify_created_at)} ·{" "}
            <a href={data.shopifyAdminUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
              Open in Shopify ↗
            </a>
          </div>
        </div>
        {can("agent") && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={busy} onClick={() => act("resend_confirmation", {}, "Confirmation queued")}>
              Resend confirmation
            </Button>
            {o.status !== "confirmed" && (
              <Button variant="secondary" onClick={() => act("mark_confirmed", {}, "Marked confirmed")}>
                Mark confirmed
              </Button>
            )}
            {!["cancelled", "cancelled_by_customer"].includes(o.status) && (
              <Button variant="secondary" onClick={() => confirm("Mark this order as cancelled by the customer?") && act("mark_cancelled", {}, "Marked cancelled")}>
                Mark cancelled
              </Button>
            )}
            {o.ad_source && (
            <Card title="Came from an ad">
              <div className="text-sm">{o.ad_source.headline || "Click-to-WhatsApp ad"}</div>
              {o.ad_source.source_url && (
                <a href={o.ad_source.source_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">
                  View ad ↗
                </a>
              )}
            </Card>
          )}

          {fulfillments.length > 0 && !(data.shipments || []).length && (
              <Button variant="secondary" onClick={() => act("send_tracking", {}, "Tracking queued")}>
                Send tracking
              </Button>
            )}
            {o.needs_attention && (
              <Button variant="ghost" onClick={() => act("resolve_attention", {}, "Resolved")}>
                Resolve
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Products">
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((i) => (
                <div key={i.id} className="flex items-center gap-3 py-2">
                  {i.image_url ? <img src={i.image_url} alt="" className="h-14 w-14 rounded-lg object-cover" /> : <div className="h-14 w-14 rounded-lg bg-gray-100 dark:bg-gray-800" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{i.title}</div>
                    <div className="text-xs text-gray-500">
                      {i.variant_title && i.variant_title !== "Default Title" ? `${i.variant_title} · ` : ""}
                      {i.sku || "no SKU"}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div>
                      {i.quantity} × {money(i.price, o.currency)}
                    </div>
                    <div className="font-medium">{money(i.quantity * i.price, o.currency)}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex justify-between border-t border-gray-100 pt-2 font-semibold dark:border-gray-800">
              <span>Total</span>
              <span>{money(o.total, o.currency)}</span>
            </div>
          </Card>

          <Card
            title="WhatsApp conversation"
            actions={
              conversation && (
                <Link to={`/inbox/${conversation.id}`}>
                  <Button size="sm" variant="secondary">
                    Open in inbox
                  </Button>
                </Link>
              )
            }
          >
            <div className="wa-chat-bg max-h-[520px] overflow-y-auto rounded-lg p-3">
              <MessageTimeline messages={messages} />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <ShipmentCard order={o} storeId={o.store_id} shipments={data.shipments || []} onChange={reload} canAct={can("agent")} />
          <AdvanceCard order={o} onChange={reload} canAct={can("agent")} />
          <Card title="Customer">
            <div className="space-y-1 text-sm">
              <div className="font-medium">{o.customer_name || "—"}</div>
              <div>{o.phone_e164 || <span className="text-red-600">No valid phone</span>}</div>
              <div className="text-gray-500">{o.email}</div>
              {customer && (
                <div className="pt-2 text-xs text-gray-500">
                  {customer.orders_count} orders · {money(customer.total_spent, o.currency)} spent
                  {customer.rfm_segment && ` · ${customer.rfm_segment.replace("_", " ")}`}
                  {customer.wa_opt_in ? " · ✅ marketing opt-in" : ""}
                </div>
              )}
            </div>
          </Card>

          <Card
            title="Delivery address"
            actions={
              can("agent") && (
                <Button size="sm" variant="ghost" onClick={() => setEditAddr({ address1: a.address1 || "", address2: a.address2 || "", city: a.city || "", province: a.province || "", zip: a.zip || "", countryCode: a.countryCode || "" })}>
                  Edit
                </Button>
              )
            }
          >
            <div className="mb-2 flex items-center gap-2">
              <Badge tone={ADDRESS_TONE[o.address_status]}>{ADDRESS_LABEL[o.address_status]}</Badge>
              {o.address_score !== null && <span className="text-sm text-gray-500">Score {o.address_score}/100</span>}
            </div>
            <div className="text-sm">{o.address_text || "—"}</div>
            {o.lat && (
              <a href={`https://www.google.com/maps?q=${o.lat},${o.lng}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-brand-700 hover:underline">
                View on Google Maps ↗
              </a>
            )}
            {addressChecks[0]?.result?.reasons?.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-xs text-gray-500">
                {addressChecks[0].result.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {can("agent") && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => act("check_address", {}, "Address check queued")}>
                  Re-check
                </Button>
                <Button size="sm" variant="secondary" onClick={() => act("request_address", {}, "Address request sent")}>
                  Ask customer on WhatsApp
                </Button>
              </div>
            )}
          </Card>

          <Card title="Risk">
            {o.risk_score === null ? (
              <div className="text-sm text-gray-500">Not scored</div>
            ) : (
              <>
                <div className="mb-2 text-2xl font-semibold">{o.risk_score}/100</div>
                <ul className="list-disc pl-4 text-xs text-gray-600 dark:text-gray-400">
                  {(o.risk_reasons || []).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="mt-3">
              <ReputationBadge rep={data.reputation} />
            </div>
          </Card>

          <Card title="Shopify tags">
            <div className="flex flex-wrap gap-1">
              {o.shopify_tags.length ? o.shopify_tags.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-sm text-gray-500">No tags</span>}
            </div>
          </Card>

          {o.ad_source && (
            <Card title="Came from an ad">
              <div className="text-sm">{o.ad_source.headline || "Click-to-WhatsApp ad"}</div>
              {o.ad_source.source_url && (
                <a href={o.ad_source.source_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">
                  View ad ↗
                </a>
              )}
            </Card>
          )}

          {fulfillments.length > 0 && !(data.shipments || []).length && (
            <Card title="Shipping">
              {fulfillments.map((f) => (
                <div key={f.id} className="text-sm">
                  <div className="font-medium">{f.tracking_company || "Courier"}</div>
                  <div>{f.tracking_number || "No tracking number"}</div>
                  {f.tracking_url && (
                    <a href={f.tracking_url} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">
                      Track ↗
                    </a>
                  )}
                  <div className="mt-1 text-xs text-gray-500">Status: {f.shipment_status || f.status}</div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={!!editAddr}
        onClose={() => setEditAddr(null)}
        title="Edit delivery address"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditAddr(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                await act("update_address", { address: editAddr }, "Address updated in Shopify");
                setEditAddr(null);
              }}
            >
              Save to Shopify
            </Button>
          </>
        }
      >
        {editAddr && (
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ["address1", "Address line 1"],
              ["address2", "Address line 2 / area"],
              ["city", "City"],
              ["province", "Province"],
              ["zip", "Postal code"],
              ["countryCode", "Country code (e.g. PK)"],
            ].map(([k, label]) => (
              <Field key={k} label={label} className={k === "address1" ? "sm:col-span-2" : ""}>
                <Input value={editAddr[k]} onChange={(e) => setEditAddr({ ...editAddr, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
