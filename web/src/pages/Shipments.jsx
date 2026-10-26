import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Banknote, CheckCircle2, PackageCheck, RotateCcw, Search, Truck, Upload } from "lucide-react";
import { useApi, post, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, num, ago, SHIP_LABEL, SHIP_TONE } from "../lib/format.js";
import { Badge, Button, Card, ErrorBox, Field, Input, Modal, PageHeader, Stat, Table, Tabs, Textarea, cx, useAction } from "../components/ui.jsx";

const TABS = [
  { value: "to_book", label: "To book" },
  { value: "active", label: "On the way" },
  { value: "problems", label: "Problems" },
  { value: "cod", label: "COD to collect" },
  { value: "delivered", label: "Delivered" },
  { value: "returned", label: "Returned" },
  { value: "settled", label: "Settled" },
];

function ImportModal({ onClose, onDone }) {
  const [csv, setCsv] = useState("");
  const [run, busy] = useAction();
  const [result, setResult] = useState(null);
  return (
    <Modal
      open
      onClose={onClose}
      title="Import courier CSV"
      footer={
        <Button
          loading={busy}
          disabled={!csv}
          onClick={() =>
            run(() => post("/shipments/import", { csv })).then((r) => {
              if (r) {
                setResult(r);
                onDone();
              }
            })
          }
        >
          <Upload className="h-4 w-4" /> Import
        </Button>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-gray-500">
          Upload the courier's status or payment report. Columns are matched by name: <b>tracking</b> (or CN), <b>status</b>, and <b>amount</b> (for COD payments). Rows with an amount are marked settled.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-semibold file:text-brand-700"
          onChange={async (e) => setCsv(await e.target.files?.[0]?.text())}
        />
        <Field label="…or paste CSV">
          <Textarea className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"tracking,status,amount\nPX123456,Delivered,2500"} />
        </Field>
        {result && (
          <div className="rounded-xl bg-brand-50 p-3 text-brand-900 dark:bg-brand-900/30 dark:text-brand-100">
            Updated {result.updated} · settled {result.settled} ({num(result.amount)}){result.unmatched.length > 0 && ` · not found: ${result.unmatched.slice(0, 5).join(", ")}${result.unmatched.length > 5 ? "…" : ""}`}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Shipments() {
  const { storeId, can } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "to_book";
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState([]);
  const [importing, setImporting] = useState(false);
  const [settleRef, setSettleRef] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setSelected([]), [tab, storeId]);
  const summary = useApi(`/shipments/summary${qs({ storeId })}`, { interval: 60000 });
  const { data, error, reload } = useApi(`/shipments${qs({ storeId, tab, q: query })}`);
  const rows = data?.rows || [];
  const s = summary.data;
  const cur = rows[0]?.currency;
  const idOf = (r) => (tab === "to_book" ? r.order_id : r.id);
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const refresh = () => {
    reload();
    summary.reload();
    setSelected([]);
  };

  const check = {
    key: "_sel",
    label: <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? [] : rows.map(idOf))} className="accent-brand-600" />,
    render: (r) => (
      <input
        type="checkbox"
        aria-label="Select"
        className="accent-brand-600"
        checked={selected.includes(idOf(r))}
        onClick={(e) => e.stopPropagation()}
        onChange={() => setSelected((x) => (x.includes(idOf(r)) ? x.filter((i) => i !== idOf(r)) : [...x, idOf(r)]))}
      />
    ),
  };

  const columns =
    tab === "to_book"
      ? [
          check,
          { key: "order", label: "Order", render: (r) => <Link className="font-semibold text-brand-700 hover:underline dark:text-brand-400" to={`/orders/${r.order_id}`}>{r.order_name}</Link> },
          { key: "customer", label: "Customer", render: (r) => <div><div>{r.customer_name}</div><div className="text-xs text-gray-500">{r.phone_e164}</div></div> },
          { key: "city", label: "City" },
          { key: "total", label: "COD", render: (r) => (r.is_cod ? money(r.total, r.currency) : <Badge tone="green">Prepaid</Badge>) },
          { key: "risk", label: "Risk", render: (r) => <Badge tone={r.risk_score >= 60 ? "red" : r.risk_score >= 30 ? "amber" : "green"}>{r.risk_score ?? "—"}</Badge> },
          { key: "confirmed", label: "Confirmed", render: (r) => ago(r.confirmed_at) },
        ]
      : [
          ...(tab === "cod" ? [check] : []),
          { key: "order", label: "Order", render: (r) => <Link className="font-semibold text-brand-700 hover:underline dark:text-brand-400" to={`/orders/${r.order_id}`}>{r.order_name}</Link> },
          { key: "courier", label: "Courier", render: (r) => <div><div>{r.courier_name}</div><div className="font-mono text-xs text-gray-500">{r.tracking_number || "—"}</div></div> },
          { key: "customer", label: "Customer", render: (r) => <div><div>{r.customer_name}</div><div className="text-xs text-gray-500">{r.city}</div></div> },
          { key: "status", label: "Status", render: (r) => <div><Badge tone={SHIP_TONE[r.status]} dot>{SHIP_LABEL[r.status]}</Badge>{r.reschedule && <div className="mt-1 text-[11px] text-amber-700">Customer: {r.reschedule.choice === "cancel" ? "cancel" : "deliver again"}</div>}</div> },
          { key: "cod", label: "COD", render: (r) => money(r.cod_amount, r.currency) },
          { key: "updated", label: tab === "settled" ? "Settled" : "Updated", render: (r) => (tab === "settled" ? <div>{ago(r.cod_settled_at)}<div className="text-xs text-gray-500">{r.settlement_ref}</div></div> : ago(r.updated_at)) },
        ];

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Truck}
        title="Shipments & COD"
        subtitle="Book couriers, follow every parcel and collect your cash"
        actions={
          can("agent") && (
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <Upload className="h-4 w-4" /> Import courier CSV
            </Button>
          )
        }
      />
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat icon={PackageCheck} label="Ready to book" value={num(s.to_book)} sub="Confirmed, no courier yet" tone={s.to_book ? "amber" : "gray"} />
          <Stat icon={Truck} label="On the way" value={num(s.active)} sub={`${money(s.cod_on_road, cur)} cash on the road`} tone="blue" />
          <Stat icon={AlertTriangle} label="Problems" value={num(s.problems)} sub={`${s.delivery_rate_30d ?? "—"}% delivery rate (30d)`} tone={s.problems ? "red" : "gray"} />
          <Stat icon={Banknote} label="COD to collect" value={money(s.cod_due, cur)} sub={`${num(s.cod_count)} delivered parcels`} tone="green" />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onChange={(v) => setParams({ tab: v })} tabs={TABS.map((t) => ({ ...t, count: t.value === "to_book" ? s?.to_book : t.value === "problems" ? s?.problems : t.value === "cod" ? s?.cod_count : undefined }))} />
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order, phone or tracking number" aria-label="Search shipments" />
        </div>
      </div>
      {selected.length > 0 && (
        <div className={cx("animate-rise flex flex-wrap items-center gap-3 rounded-2xl bg-navy-900 px-4 py-3 text-sm text-white shadow-lift")}>
          <span className="font-semibold">{selected.length} selected</span>
          {tab === "to_book" && (
            <Button
              size="sm"
              loading={busy}
              onClick={() =>
                run(() => post("/shipments/book-bulk", { orderIds: selected })).then((r) => {
                  if (r) {
                    alert(`Booked ${r.booked}${r.failed ? `, failed ${r.failed}:\n${r.results.filter((x) => !x.ok).map((x) => `#${x.orderId}: ${x.error}`).join("\n")}` : ""}`);
                    refresh();
                  }
                })
              }
            >
              <Truck className="h-4 w-4" /> Book selected
            </Button>
          )}
          {tab === "cod" && (
            <Button size="sm" onClick={() => setSettleRef("")}>
              <CheckCircle2 className="h-4 w-4" /> Mark cash received
            </Button>
          )}
          <button className="ml-auto text-xs text-slate-300 hover:text-white" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      )}
      <ErrorBox error={error} />
      <Card padded={false}>
        <Table columns={columns} rows={rows} empty={tab === "to_book" ? "Nothing waiting. Confirmed orders appear here until they are booked." : "Nothing here"} />
      </Card>
      {tab === "returned" && rows.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-gray-500">
          <RotateCcw className="h-3.5 w-3.5" /> Numbers that return parcels too often are blocked automatically (Fraud protection).
        </p>
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={refresh} />}
      {settleRef !== null && (
        <Modal
          open
          onClose={() => setSettleRef(null)}
          title="Mark cash received"
          footer={
            <Button loading={busy} onClick={() => run(() => post("/shipments/settle", { ids: selected, ref: settleRef }), "Marked as settled").then(() => (setSettleRef(null), refresh()))}>
              Confirm
            </Button>
          }
        >
          <Field label="Payment reference (optional)" hint="e.g. the courier's payment or cheque number">
            <Input value={settleRef} onChange={(e) => setSettleRef(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}
