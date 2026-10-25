import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, num, dateTime } from "../lib/format.js";
import { Card, Stat, Table, Badge, Button, Input, Loading, ErrorBox, useAction } from "../components/ui.jsx";
import { BarList } from "../components/charts.jsx";

export default function CampaignDetail() {
  const { id } = useParams();
  const { stores } = useSession();
  const { data, error, reload } = useApi(`/campaigns/${id}`, { interval: 10000 });
  const [run, busy] = useAction();
  const [testPhone, setTestPhone] = useState("");
  const [when, setWhen] = useState("");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const { campaign: c, stats, recipients } = data;
  const t = stats.total;
  const cur = stores.find((st) => st.id === c.store_id)?.currency || "USD";
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");

  return (
    <div className="space-y-4">
      <div>
        <Link to="/marketing" className="text-sm text-gray-500 hover:underline">
          ← Marketing
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
          {c.name} <Badge tone={{ sent: "green", sending: "blue", scheduled: "amber", failed: "red" }[c.status]}>{c.status}</Badge>
        </h1>
        {c.stats?.error && <div className="mt-1 text-sm text-red-600">{c.stats.error}</div>}
      </div>

      {["draft", "scheduled"].includes(c.status) && (
        <Card title="Send">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex gap-2">
              <Input placeholder="Your WhatsApp number" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
              <Button variant="secondary" loading={busy} onClick={() => run(() => post(`/campaigns/${c.id}/test`, { phone: testPhone }), "Test sent")}>
                Send test
              </Button>
            </div>
            <div className="flex gap-2">
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              <Button variant="secondary" disabled={!when} onClick={() => run(() => post(`/campaigns/${c.id}/schedule`, { at: new Date(when).toISOString() }), "Scheduled").then(reload)}>
                Schedule
              </Button>
            </div>
            <Button onClick={() => confirm("Send this campaign now to the whole audience?") && run(() => post(`/campaigns/${c.id}/schedule`, {}), "Sending started").then(reload)}>
              Send now
            </Button>
            {c.status === "scheduled" && (
              <Button variant="danger" onClick={() => run(() => post(`/campaigns/${c.id}/cancel`), "Cancelled").then(reload)}>
                Cancel
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-500">Messages are throttled to protect your number's quality rating and pause during quiet hours.</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Recipients" value={num(t.recipients)} />
        <Stat label="Delivered" value={pct(t.delivered, t.sent)} sub={`${num(t.delivered)} of ${num(t.sent)}`} />
        <Stat label="Read" value={pct(t.read, t.sent)} sub={num(t.read)} />
        <Stat label="Clicked" value={pct(t.clicked, t.sent)} sub={num(t.clicked)} tone="blue" />
        <Stat label="Revenue" value={money(t.revenue, cur)} sub={`${num(t.orders)} orders · cost ~${money(t.cost, "USD")}`} tone="green" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Funnel">
          <BarList
            rows={[
              { label: "Sent", value: Number(t.sent) },
              { label: "Delivered", value: Number(t.delivered) },
              { label: "Read", value: Number(t.read) },
              { label: "Clicked", value: Number(t.clicked) },
              { label: "Ordered", value: Number(t.orders) },
            ]}
          />
        </Card>
        {stats.byVariant.length > 1 && (
          <Card title="A/B test">
            <Table
              rows={stats.byVariant}
              columns={[
                { key: "variant", label: "Variant" },
                { key: "sent", label: "Sent" },
                { key: "read", label: "Read", render: (v) => pct(v.read, v.sent) },
                { key: "clicked", label: "Clicked", render: (v) => pct(v.clicked, v.sent) },
                { key: "orders", label: "Orders" },
                { key: "revenue", label: "Revenue", render: (v) => money(v.revenue, cur) },
              ]}
            />
          </Card>
        )}
      </div>

      <Card title="Recipients" padded={false}>
        <Table
          rows={recipients}
          columns={[
            { key: "name", label: "Customer", render: (r) => <div>{r.name}<div className="text-xs text-gray-500">{r.phone_e164}</div></div> },
            { key: "variant", label: "Variant" },
            { key: "status", label: "Status", render: (r) => <Badge tone={r.status === "sent" ? "green" : r.status === "pending" ? "gray" : "red"}>{r.message_status || r.status}</Badge> },
            { key: "discount_code", label: "Code" },
            { key: "clicked_at", label: "Clicked", render: (r) => (r.clicked_at ? dateTime(r.clicked_at) : "—") },
            { key: "revenue", label: "Revenue", render: (r) => (r.revenue ? money(r.revenue, cur) : "—") },
          ]}
        />
      </Card>
    </div>
  );
}
