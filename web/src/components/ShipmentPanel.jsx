import { useState } from "react";
import { AlertTriangle, BadgeCheck, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck, Truck, Wallet } from "lucide-react";
import { useApi, post, put } from "../lib/api.js";
import { money, dateTime, SHIP_LABEL, SHIP_TONE } from "../lib/format.js";
import { Badge, Button, Card, Field, Input, Modal, Select, useAction } from "./ui.jsx";

const REP_TONE = { trusted: "green", new: "gray", risky: "amber", bad: "red", blocked: "red" };
const REP_LABEL = { trusted: "Trusted buyer", new: "New buyer", risky: "Risky", bad: "Returns parcels", blocked: "Blocked" };

/** The customer's delivery record across every store on the platform. */
export function ReputationBadge({ rep }) {
  if (!rep) return null;
  return (
    <div className="rounded-xl bg-gray-50 p-3 text-xs dark:bg-gray-800/50">
      <div className="mb-1.5 flex items-center gap-2">
        {rep.level === "trusted" ? <ShieldCheck className="h-4 w-4 text-brand-600" /> : <ShieldAlert className="h-4 w-4 text-amber-500" />}
        <Badge tone={REP_TONE[rep.level]}>{REP_LABEL[rep.level]}</Badge>
      </div>
      <div className="text-gray-600 dark:text-gray-300">
        Network record: {rep.orders} other orders in {rep.stores} store(s) · {rep.delivered} delivered · {rep.returned} returned/refused · {rep.cancelled} cancelled
        {rep.deliveryRate !== null && ` · ${rep.deliveryRate}% delivery rate`}
      </div>
      {rep.blocked && <div className="mt-1 font-semibold text-red-600">Blocked{rep.blocked.reason ? `: ${rep.blocked.reason}` : ""}</div>}
    </div>
  );
}

function BookForm({ order, storeId, onDone }) {
  const couriers = useApi(`/stores/${storeId}/couriers`);
  const [f, setF] = useState({ courierId: "", weightKg: "", trackingNumber: "", notes: "" });
  const [run, busy] = useAction();
  const list = (couriers.data || []).filter((c) => c.active);
  const chosen = list.find((c) => String(c.id) === String(f.courierId)) || list.find((c) => c.is_default) || list[0];
  if (couriers.data && !list.length) {
    return (
      <p className="text-sm text-gray-500">
        No courier yet. <a className="font-semibold text-brand-700 hover:underline" href={`/stores/${storeId}?tab=couriers`}>Add one under Store → Couriers</a>.
      </p>
    );
  }
  const blocked = order.advance_status === "requested";
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Courier">
          <Select value={f.courierId || chosen?.id || ""} onChange={(e) => setF({ ...f, courierId: e.target.value })}>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_default ? " (default)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Weight (kg)">
          <Input type="number" step="0.1" min="0.1" value={f.weightKg} onChange={(e) => setF({ ...f, weightKg: e.target.value })} placeholder="default" />
        </Field>
      </div>
      {chosen?.provider === "manual" && (
        <Field label="Tracking number">
          <Input value={f.trackingNumber} onChange={(e) => setF({ ...f, trackingNumber: e.target.value })} />
        </Field>
      )}
      <Field label="Note for the rider (optional)">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={250} />
      </Field>
      {blocked && <p className="text-xs text-amber-700">This order is waiting for its advance payment. Booking now ignores that.</p>}
      <Button
        loading={busy}
        onClick={() =>
          run(
            () =>
              post(`/orders/${order.id}/book`, {
                courierId: Number(f.courierId || chosen?.id) || null,
                weightKg: f.weightKg ? Number(f.weightKg) : undefined,
                trackingNumber: f.trackingNumber || undefined,
                notes: f.notes || undefined,
                force: blocked || undefined,
              }),
            "Shipment booked"
          ).then((r) => r && onDone())
        }
      >
        <Truck className="h-4 w-4" /> Book shipment
      </Button>
    </div>
  );
}

export function ShipmentCard({ order, storeId, shipments, onChange, canAct }) {
  const [run, busy] = useAction();
  const [status, setStatus] = useState(null);
  const sh = shipments.find((s) => s.status !== "cancelled");
  return (
    <Card title="Courier & delivery" icon={Truck}>
      {!sh ? (
        canAct && !["cancelled", "cancelled_by_customer", "returned"].includes(order.status) ? <BookForm order={order} storeId={storeId} onDone={onChange} /> : <p className="text-sm text-gray-500">Not shipped.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold">{sh.courier_name}</div>
              <div className="font-mono text-xs">{sh.tracking_number || "No tracking number yet"}</div>
            </div>
            <Badge tone={SHIP_TONE[sh.status]} dot>
              {SHIP_LABEL[sh.status]}
            </Badge>
          </div>
          {sh.status_raw && <div className="text-xs text-gray-500">Courier says: {sh.status_raw}</div>}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50">
              <div className="text-gray-500">Cash to collect</div>
              <div className="font-semibold">{money(sh.cod_amount, order.currency)}</div>
            </div>
            <div className="rounded-lg bg-gray-50 p-2 dark:bg-gray-800/50">
              <div className="text-gray-500">COD settled</div>
              <div className="font-semibold">{sh.cod_settled_at ? dateTime(sh.cod_settled_at) : sh.status === "delivered" ? "Waiting" : "—"}</div>
            </div>
          </div>
          {sh.reschedule && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Customer chose <b>{sh.reschedule.choice === "cancel" ? "cancel / return" : "deliver again"}</b> · {dateTime(sh.reschedule.at)}
              </span>
            </div>
          )}
          {(sh.events || []).length > 0 && (
            <ol className="max-h-40 space-y-1 overflow-y-auto border-l-2 border-gray-100 pl-3 text-xs dark:border-gray-800">
              {[...sh.events].reverse().map((e, i) => (
                <li key={i}>
                  <span className="font-medium">{e.status}</span> <span className="text-gray-400">{e.at ? dateTime(e.at) : ""}</span>
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap gap-2">
            {sh.tracking_url && (
              <a href={sh.tracking_url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="secondary">
                  <ExternalLink className="h-3.5 w-3.5" /> Track
                </Button>
              </a>
            )}
            {sh.label_url && (
              <a href={sh.label_url} target="_blank" rel="noreferrer">
                <Button size="sm" variant="secondary">Label</Button>
              </a>
            )}
            {canAct && sh.provider !== "manual" && (
              <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => post(`/shipments/${sh.id}/sync`), "Status refreshed").then(onChange)}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            )}
            {canAct && (
              <Button size="sm" variant="ghost" onClick={() => setStatus({ status: sh.status, note: "", trackingNumber: sh.tracking_number || "" })}>
                Update status
              </Button>
            )}
          </div>
        </div>
      )}
      {status && (
        <Modal
          open
          onClose={() => setStatus(null)}
          title="Update shipment"
          footer={
            <Button loading={busy} onClick={() => run(() => put(`/shipments/${sh.id}/status`, status), "Shipment updated").then(() => (setStatus(null), onChange()))}>
              Save
            </Button>
          }
        >
          <div className="space-y-3">
            <Field label="Status">
              <Select value={status.status} onChange={(e) => setStatus({ ...status, status: e.target.value })} options={Object.entries(SHIP_LABEL).map(([value, label]) => ({ value, label }))} />
            </Field>
            <Field label="Tracking number">
              <Input value={status.trackingNumber} onChange={(e) => setStatus({ ...status, trackingNumber: e.target.value })} />
            </Field>
            <Field label="Note">
              <Input value={status.note} onChange={(e) => setStatus({ ...status, note: e.target.value })} placeholder="e.g. Rider called, customer not home" />
            </Field>
            <p className="text-xs text-gray-500">Delivered, failed and returned statuses send the same WhatsApp messages and notifications as automatic tracking.</p>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export function AdvanceCard({ order, onChange, canAct }) {
  const [run, busy] = useAction();
  const [amount, setAmount] = useState("");
  if (!order.is_cod && order.advance_status === "none") return null;
  const tone = { none: "gray", requested: "amber", paid: "green", waived: "gray" }[order.advance_status];
  return (
    <Card title="Advance payment" icon={Wallet}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <Badge tone={tone} dot>
            {{ none: "Not requested", requested: "Waiting for payment", paid: "Paid", waived: "Waived" }[order.advance_status]}
          </Badge>
          {order.advance_amount && <span className="font-semibold">{money(order.advance_amount, order.currency)}</span>}
        </div>
        {order.advance_link && (
          <a href={order.advance_link} target="_blank" rel="noreferrer" className="text-xs text-brand-700 hover:underline">
            Card payment link ↗
          </a>
        )}
        {canAct && order.advance_status === "none" && (
          <div className="flex gap-2">
            <Input type="number" min="1" placeholder="Amount (default from settings)" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <Button variant="secondary" loading={busy} onClick={() => run(() => post(`/orders/${order.id}/advance/request`, amount ? { amount: Number(amount) } : {}), "Advance requested on WhatsApp").then(onChange)}>
              Request
            </Button>
          </div>
        )}
        {canAct && order.advance_status === "requested" && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy} onClick={() => run(() => post(`/orders/${order.id}/advance/paid`), "Marked paid").then(onChange)}>
              <BadgeCheck className="h-4 w-4" /> Mark advance paid
            </Button>
            <Button size="sm" variant="ghost" onClick={() => run(() => post(`/orders/${order.id}/advance/waive`), "Waived").then(onChange)}>
              Waive
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
