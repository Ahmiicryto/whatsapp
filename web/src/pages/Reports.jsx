import { BarChart3 } from "lucide-react";
import { useState } from "react";
import { useApi, post, put, del } from "../lib/api.js";
import { useSession, useSingleStore } from "../lib/session.jsx";
import { useStoreSettings } from "../lib/useStoreSettings.js";
import { dateTime, num, money } from "../lib/format.js";
import { Card, Table, Badge, Button, PageHeader, Modal, Field, Input, Select, Toggle, useAction } from "../components/ui.jsx";

const REPORTS = ["daily", "weekly", "monthly", "alerts"];

function ContactModal({ contact, stores, onClose, onSaved }) {
  const [c, setC] = useState(contact?.id ? { ...contact, phone: contact.phone_e164 } : { name: "", phone: "", store_id: stores[0]?.id ?? null, reports: ["daily", "alerts"], language: "en", enabled: true });
  const [run, busy] = useAction();
  return (
    <Modal
      open
      onClose={onClose}
      title={contact?.id ? "Edit owner number" : "Add owner number"}
      footer={
        <Button
          loading={busy}
          onClick={async () => {
            const body = { name: c.name, phone: c.phone, store_id: c.store_id ? Number(c.store_id) : null, reports: c.reports, language: c.language, enabled: c.enabled };
            const r = await run(() => (contact?.id ? put(`/owner-contacts/${contact.id}`, body) : post("/owner-contacts", body)), "Saved");
            if (r) onSaved();
          }}
        >
          Save
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </Field>
        <Field label="WhatsApp number">
          <Input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} placeholder="+92 300 1234567" />
        </Field>
        <Field label="Reports for">
          <Select value={c.store_id ?? ""} onChange={(e) => setC({ ...c, store_id: e.target.value || null })}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="">All stores combined</option>
          </Select>
        </Field>
        <div className="flex flex-wrap gap-4">
          {REPORTS.map((r) => (
            <Toggle key={r} checked={c.reports.includes(r)} onChange={(v) => setC({ ...c, reports: v ? [...c.reports, r] : c.reports.filter((x) => x !== r) })} label={r} />
          ))}
        </div>
        <Toggle checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} label="Enabled" />
      </div>
    </Modal>
  );
}

export default function Reports() {
  const { stores, can } = useSession();
  const { store } = useSingleStore();
  const contacts = useApi("/owner-contacts");
  const reports = useApi("/reports", { interval: 30000 });
  const s = useStoreSettings(store?.id);
  const [editing, setEditing] = useState(null);
  const [run, busy] = useAction();

  return (
    <div className="space-y-4">
      <PageHeader
        icon={BarChart3}
        title="Reports"
        subtitle="Daily, weekly and monthly reports with charts are sent to owner numbers on WhatsApp as a PDF."
        actions={
          can("admin") && (
            <>
              <Button variant="secondary" loading={busy} disabled={!store} onClick={() => run(() => post("/reports/run", { storeId: store.id, type: "daily", send: false }), "Report generated").then(reports.reload)}>
                Generate now
              </Button>
              <Button loading={busy} disabled={!store} onClick={() => run(() => post("/reports/run", { storeId: store.id, type: "daily", send: true }), "Report sent to owners").then(reports.reload)}>
                Send today's report
              </Button>
            </>
          )
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Owner numbers" actions={can("admin") && <Button size="sm" onClick={() => setEditing({})}>Add</Button>}>
          <Table
            rows={contacts.data || []}
            empty="Add the owner's WhatsApp number to receive reports and alerts"
            columns={[
              { key: "name", label: "Name", render: (c) => <div><div className="font-medium">{c.name}</div><div className="text-xs text-gray-500">{c.phone_e164}</div></div> },
              { key: "store", label: "Store", render: (c) => c.store_name || "All stores" },
              { key: "reports", label: "Gets", render: (c) => <div className="flex flex-wrap gap-1">{c.reports.map((r) => <Badge key={r}>{r}</Badge>)}</div> },
              {
                key: "actions",
                label: "",
                render: (c) =>
                  can("admin") && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => run(() => post(`/owner-contacts/${c.id}/test`), "Test report sent")}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => confirm("Remove this number?") && run(() => del(`/owner-contacts/${c.id}`), "Removed").then(contacts.reload)}>
                        ✕
                      </Button>
                    </div>
                  ),
              },
            ]}
          />
        </Card>
        {store && s.draft && (
          <Card title={`Schedule for ${store.name}`} actions={can("admin") && <Button size="sm" loading={busy} onClick={() => run(() => s.save(["reports"]), "Saved")}>Save</Button>}>
            <div className="space-y-3">
              <Field label="Send time (store timezone)">
                <Input type="time" value={s.get("reports.time")} onChange={(e) => s.set("reports.time", e.target.value)} className="w-40" />
              </Field>
              <Toggle checked={s.get("reports.daily")} onChange={(v) => s.set("reports.daily", v)} label="Daily report" />
              <Toggle checked={s.get("reports.weekly")} onChange={(v) => s.set("reports.weekly", v)} label="Weekly report (Mondays)" />
              <Toggle checked={s.get("reports.monthly")} onChange={(v) => s.set("reports.monthly", v)} label="Monthly report (1st of the month)" />
              <Toggle checked={s.get("reports.aiSummary")} onChange={(v) => s.set("reports.aiSummary", v)} label="Add AI summary and recommended actions" />
            </div>
          </Card>
        )}
      </div>
      <Card title="Report history" padded={false}>
        <Table
          rows={reports.data || []}
          columns={[
            { key: "type", label: "Report", render: (r) => <div className="font-medium capitalize">{r.type} · {r.period_key}</div> },
            { key: "store", label: "Store", render: (r) => r.store_name || "All stores" },
            { key: "orders", label: "Orders", render: (r) => num(r.kpis?.orders) },
            { key: "revenue", label: "Revenue", render: (r) => money(r.kpis?.revenue, stores.find((x) => x.id === r.store_id)?.currency || "USD") },
            { key: "confirmed", label: "Confirmed", render: (r) => `${r.kpis?.confirmation_rate ?? 0}%` },
            { key: "summary", label: "AI summary", render: (r) => <span className="line-clamp-2 max-w-sm text-xs text-gray-500">{r.insights?.summary || "—"}</span> },
            { key: "sent", label: "Sent to", render: (r) => `${(r.sent_to || []).filter((x) => x.ok).length} owners` },
            { key: "created_at", label: "Created", render: (r) => dateTime(r.created_at) },
            { key: "pdf", label: "", render: (r) => <a className="text-sm text-brand-700" href={`/api/reports/${r.id}/pdf`} target="_blank" rel="noreferrer">PDF</a> },
          ]}
        />
      </Card>
      {editing && (
        <ContactModal
          contact={editing}
          stores={stores}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            contacts.reload();
          }}
        />
      )}
    </div>
  );
}
