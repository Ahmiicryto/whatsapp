import { Users } from "lucide-react";
import { useState } from "react";
import { useApi, qs, patch, post } from "../lib/api.js";
import { useSession, useSingleStore } from "../lib/session.jsx";
import { money, date } from "../lib/format.js";
import { Card, Table, Badge, Input, Select, Button, PageHeader, Modal, Textarea, Toggle, Field, useAction } from "../components/ui.jsx";

const RFM = ["champions", "loyal", "promising", "new", "at_risk", "cant_lose", "hibernating"];

function ImportModal({ open, onClose, onDone }) {
  const { store } = useSingleStore();
  const [csv, setCsv] = useState("phone,name,email,city,tags\n");
  const [consent, setConsent] = useState(false);
  const [run, busy] = useAction();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Import opted-in customers${store ? ` to ${store.name}` : ""}`}
      footer={
        <Button
          loading={busy}
          disabled={!consent || !store}
          onClick={async () => {
            const r = await run(() => post("/customers/import", { storeId: store.id, csv, consent }));
            if (r) {
              onDone(`Imported ${r.imported}, skipped ${r.skipped} invalid numbers`);
              onClose();
            }
          }}
        >
          Import
        </Button>
      }
    >
      <Field label="Paste CSV (columns: phone, name, email, city, tags separated by ;)">
        <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} className="min-h-[180px] font-mono text-xs" />
      </Field>
      <div className="mt-3">
        <Toggle checked={consent} onChange={setConsent} label="These customers agreed to receive WhatsApp messages from us" hint="Required by WhatsApp policy before sending marketing messages." />
      </div>
    </Modal>
  );
}

export default function Customers() {
  const { storeId, can } = useSession();
  const [f, setF] = useState({ q: "", optIn: "", rfm: "", page: 1 });
  const [importing, setImporting] = useState(false);
  const [run] = useAction();
  const { data, reload } = useApi(`/customers${qs({ storeId, ...f })}`);
  const [notice, setNotice] = useState(null);

  return (
    <div className="space-y-4">
      <PageHeader icon={Users} title="Customers" subtitle="Synced from orders, checkouts and Shopify customers" actions={can("admin") && <Button variant="secondary" onClick={() => setImporting(true)}>Import CSV</Button>} />
      {notice && <div className="rounded-lg bg-brand-50 p-3 text-sm text-brand-700">{notice}</div>}
      {data?.rfm?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.rfm.map((r) => (
            <button key={r.rfm_segment} onClick={() => setF({ ...f, rfm: f.rfm === r.rfm_segment ? "" : r.rfm_segment, page: 1 })} className={`rounded-full border px-3 py-1 text-xs ${f.rfm === r.rfm_segment ? "border-brand-600 bg-brand-50 text-brand-700" : "border-gray-200 dark:border-gray-700"}`}>
              {r.rfm_segment.replace("_", " ")} · {r.n}
            </button>
          ))}
        </div>
      )}
      <Card padded={false}>
        <div className="grid gap-2 border-b border-gray-100 p-3 sm:grid-cols-3 dark:border-gray-800">
          <Input placeholder="Search name, phone, email, city" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
          <Select value={f.optIn} onChange={(e) => setF({ ...f, optIn: e.target.value })} options={[{ value: "", label: "Any opt-in" }, { value: "1", label: "Opted in" }, { value: "0", label: "Not opted in" }]} />
          <Select value={f.rfm} onChange={(e) => setF({ ...f, rfm: e.target.value })} options={[{ value: "", label: "Any segment" }, ...RFM.map((r) => ({ value: r, label: r.replace("_", " ") }))]} />
        </div>
        <Table
          rows={data?.rows || []}
          columns={[
            { key: "name", label: "Customer", render: (c) => <div><div className="font-medium">{c.name || "—"}</div><div className="text-xs text-gray-500">{c.phone_e164}</div></div> },
            { key: "city", label: "City" },
            { key: "orders_count", label: "Orders" },
            { key: "total_spent", label: "Spent", render: (c) => money(c.total_spent, c.currency) },
            { key: "last", label: "Last order", render: (c) => date(c.last_order_at) },
            { key: "rfm", label: "Segment", render: (c) => (c.rfm_segment ? <Badge tone="blue">{c.rfm_segment.replace("_", " ")}</Badge> : "—") },
            {
              key: "optin",
              label: "WhatsApp offers",
              render: (c) =>
                can("agent") ? (
                  <Toggle checked={c.wa_opt_in && !c.opted_out_at} onChange={(v) => run(() => patch(`/customers/${c.id}`, { wa_opt_in: v }), v ? "Opted in" : "Opted out").then(reload)} label={c.opt_in_source || (c.opted_out_at ? "opted out" : "")} />
                ) : c.wa_opt_in ? (
                  "Yes"
                ) : (
                  "No"
                ),
            },
            ...(storeId === "all" ? [{ key: "store_name", label: "Store" }] : []),
          ]}
        />
        {data && data.total > 50 && (
          <div className="flex justify-end gap-2 border-t border-gray-100 p-3 dark:border-gray-800">
            <Button size="sm" variant="secondary" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" disabled={f.page * 50 >= data.total} onClick={() => setF({ ...f, page: f.page + 1 })}>
              Next
            </Button>
          </div>
        )}
      </Card>
      <ImportModal open={importing} onClose={() => setImporting(false)} onDone={(m) => { setNotice(m); reload(); }} />
    </div>
  );
}
