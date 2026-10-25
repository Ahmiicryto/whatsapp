import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, post, patch, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { dateTime, num, money, ago, STATUS_LABEL, STATUS_TONE } from "../lib/format.js";
import { Card, Stat, Table, Badge, Button, PageHeader, Tabs, Input, Loading, ErrorBox, Select, useAction } from "../components/ui.jsx";
import { TrendChart, BarList } from "../components/charts.jsx";

function Overview() {
  const { data, error } = useApi("/admin/overview", { interval: 60000 });
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  const k = data.metrics.kpis;
  const m = data.metrics.messages;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Accounts" value={num(t.accounts)} sub={`${num(t.suspended)} suspended · ${num(t.users)} users`} />
        <Stat label="Stores" value={num(t.stores)} sub={`${num(t.active_stores)} active · ${num(t.numbers)} WhatsApp numbers`} />
        <Stat label="Orders (30d)" value={num(k.orders)} sub={`${k.confirmation_rate}% confirmed`} tone="green" />
        <Stat label="Messages (30d)" value={num(m.sent)} sub={`${m.read_rate}% read · ${num(m.failed)} failed`} />
        <Stat label="Queue backlog" value={num(t.queue_backlog)} tone={Number(t.queue_backlog) > 100 ? "amber" : "gray"} />
        <Stat label="Failed jobs (24h)" value={num(t.failed_jobs_24h)} tone={Number(t.failed_jobs_24h) ? "red" : "gray"} />
        <Stat label="AI calls (30d)" value={num(data.metrics.ai.calls)} sub={`${num(data.metrics.ai.tokens)} tokens`} tone="blue" />
        <Stat label="Est. Meta cost (30d)" value={money(m.cost, "USD")} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Platform orders per day">
          <TrendChart
            data={data.metrics.series.map((d) => ({ ...d, orders: Number(d.orders), confirmed: Number(d.confirmed), cancelled: Number(d.cancelled) }))}
            series={[
              { key: "orders", label: "Orders" },
              { key: "confirmed", label: "Confirmed" },
              { key: "cancelled", label: "Cancelled" },
            ]}
          />
        </Card>
        <Card title="Busiest stores (30d)">
          <BarList rows={data.topStores.map((s) => ({ label: `${s.name} · ${s.account}`, value: Number(s.orders), display: num(s.orders) }))} />
        </Card>
      </div>
    </div>
  );
}

function Accounts() {
  const { data, reload } = useApi("/admin/accounts");
  const [run] = useAction();
  const { refresh, setStoreId } = useSession();
  const navigate = useNavigate();
  async function view(a) {
    await run(() => post("/admin/view-account", { accountId: a.id }));
    setStoreId("all");
    await refresh();
    navigate("/");
  }
  return (
    <Card padded={false}>
      <Table
        rows={data || []}
        columns={[
          { key: "name", label: "Account", render: (a) => <div><div className="font-medium">{a.name}</div><div className="text-xs text-gray-500">{(a.owners || []).join(", ")}</div></div> },
          { key: "status", label: "Status", render: (a) => <Badge tone={a.status === "active" ? "green" : "red"}>{a.status}</Badge> },
          { key: "stores", label: "Stores" },
          { key: "users", label: "Users" },
          { key: "orders_30d", label: "Orders 30d", render: (a) => num(a.orders_30d) },
          { key: "usage", label: "This month", render: (a) => (a.usage ? `${num(a.usage.messages)} msgs · ${num(a.usage.ai_tokens)} AI tokens` : "—") },
          { key: "created_at", label: "Since", render: (a) => dateTime(a.created_at) },
          {
            key: "actions",
            label: "",
            render: (a) => (
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="secondary" onClick={() => view(a)}>
                  Open
                </Button>
                <Button size="sm" variant="ghost" onClick={() => run(() => patch(`/admin/accounts/${a.id}`, { status: a.status === "active" ? "suspended" : "active" }), "Updated").then(reload)}>
                  {a.status === "active" ? "Suspend" : "Activate"}
                </Button>
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

function Stores() {
  const { data } = useApi("/admin/stores");
  return (
    <Card padded={false}>
      <Table
        rows={data || []}
        columns={[
          { key: "name", label: "Store", render: (s) => <div><div className="font-medium">{s.name}</div><div className="text-xs text-gray-500">{s.shopify_domain}</div></div> },
          { key: "account", label: "Account" },
          { key: "status", label: "Status", render: (s) => <Badge tone={s.status === "active" ? "green" : "red"}>{s.status}</Badge> },
          { key: "wa", label: "WhatsApp", render: (s) => (s.display_number ? `${s.display_number} (${s.quality_rating || "?"})` : "—") },
          { key: "orders", label: "Orders", render: (s) => num(s.orders) },
          { key: "messages_30d", label: "Msgs 30d", render: (s) => num(s.messages_30d) },
          { key: "failed_jobs", label: "Failed", render: (s) => (Number(s.failed_jobs) ? <Badge tone="red">{s.failed_jobs}</Badge> : "0") },
          { key: "sync", label: "Last sync", render: (s) => ago(s.last_reconciled_at) },
        ]}
      />
    </Card>
  );
}

function Users() {
  const { data, reload } = useApi("/admin/users");
  const [run] = useAction();
  const { refresh } = useSession();
  const navigate = useNavigate();
  return (
    <Card padded={false}>
      <Table
        rows={data || []}
        columns={[
          { key: "email", label: "User", render: (u) => <div><div className="font-medium">{u.name}</div><div className="text-xs text-gray-500">{u.email}</div></div> },
          { key: "accounts", label: "Accounts", render: (u) => (u.accounts || []).map((a) => `${a.account} (${a.role})`).join(", ") || (u.is_super_admin ? "super admin" : "—") },
          { key: "status", label: "Status", render: (u) => <Badge tone={u.status === "active" ? "green" : "red"}>{u.status}</Badge> },
          { key: "last", label: "Last sign-in", render: (u) => dateTime(u.last_login_at) },
          {
            key: "actions",
            label: "",
            render: (u) =>
              !u.is_super_admin && (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="secondary" onClick={() => run(() => post("/admin/impersonate", { userId: u.id })).then(async () => { await refresh(); navigate("/"); })}>
                    Impersonate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => run(() => patch(`/admin/users/${u.id}`, { status: u.status === "active" ? "disabled" : "active" }), "Updated").then(reload)}>
                    {u.status === "active" ? "Disable" : "Enable"}
                  </Button>
                </div>
              ),
          },
        ]}
      />
    </Card>
  );
}

function Orders() {
  const [q, setQ] = useState("");
  const { data } = useApi(`/admin/orders${qs({ q })}`);
  return (
    <Card padded={false}>
      <div className="border-b border-gray-100 p-3 dark:border-gray-800">
        <Input placeholder="Search every store: order, customer, phone, store" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Table
        rows={data || []}
        columns={[
          { key: "name", label: "Order", render: (o) => <span className="font-medium">{o.name}</span> },
          { key: "store", label: "Store", render: (o) => <div>{o.store_name}<div className="text-xs text-gray-500">{o.account}</div></div> },
          { key: "customer_name", label: "Customer", render: (o) => <div>{o.customer_name}<div className="text-xs text-gray-500">{o.phone_e164}</div></div> },
          { key: "total", label: "Total", render: (o) => money(o.total, o.currency) },
          { key: "status", label: "Status", render: (o) => <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge> },
          { key: "date", label: "Date", render: (o) => dateTime(o.shopify_created_at) },
        ]}
      />
    </Card>
  );
}

function Messages() {
  const [status, setStatus] = useState("");
  const { data } = useApi(`/admin/messages${qs({ status })}`);
  return (
    <Card padded={false}>
      <div className="border-b border-gray-100 p-3 dark:border-gray-800">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48" options={[{ value: "", label: "All messages" }, { value: "failed", label: "Failed" }, { value: "read", label: "Read" }, { value: "received", label: "Inbound" }]} />
      </div>
      <Table
        rows={data || []}
        columns={[
          { key: "created_at", label: "When", render: (m) => dateTime(m.created_at) },
          { key: "store_name", label: "Store" },
          { key: "kind", label: "Kind", render: (m) => `${m.direction === "in" ? "⬅" : "➡"} ${m.kind}` },
          { key: "to_phone", label: "Number" },
          { key: "body", label: "Message", render: (m) => <span className="line-clamp-2 max-w-md text-xs">{m.body}</span> },
          { key: "status", label: "Status", render: (m) => <div><Badge tone={m.status === "failed" ? "red" : "gray"}>{m.status}</Badge>{m.error_text && <div className="text-xs text-red-600">{m.error_text}</div>}</div> },
        ]}
      />
    </Card>
  );
}

function Jobs() {
  const { data, reload } = useApi("/admin/jobs", { interval: 15000 });
  const [run] = useAction();
  return (
    <div className="space-y-4">
      <Card title="Last 24 hours">
        <div className="flex flex-wrap gap-2">
          {(data?.stats || []).map((s) => (
            <Badge key={`${s.name}${s.status}`} tone={s.status === "failed" ? "red" : s.status === "done" ? "green" : "amber"}>
              {s.name} · {s.status} · {s.n}
            </Badge>
          ))}
        </div>
      </Card>
      <Card title="Failed jobs" padded={false}>
        <Table
          rows={data?.failed || []}
          empty="No failed jobs"
          columns={[
            { key: "name", label: "Job" },
            { key: "store_name", label: "Store" },
            { key: "last_error", label: "Error", render: (j) => <span className="text-xs text-red-600">{j.last_error}</span> },
            { key: "updated_at", label: "When", render: (j) => dateTime(j.updated_at) },
            { key: "retry", label: "", render: (j) => <Button size="sm" variant="secondary" onClick={() => run(() => post(`/admin/jobs/${j.id}/retry`), "Retrying").then(reload)}>Retry</Button> },
          ]}
        />
      </Card>
    </div>
  );
}

function Audit() {
  const { data } = useApi("/admin/audit");
  return (
    <Card padded={false}>
      <Table
        rows={data || []}
        columns={[
          { key: "created_at", label: "When", render: (a) => dateTime(a.created_at) },
          { key: "actor_email", label: "Who", render: (a) => <span>{a.actor_email || "system"}{a.impersonator_email && <span className="text-xs text-purple-600"> via {a.impersonator_email}</span>}</span> },
          { key: "account_name", label: "Account" },
          { key: "action", label: "Action" },
          { key: "target", label: "Target" },
        ]}
      />
    </Card>
  );
}

export default function Admin() {
  const [tab, setTab] = useState("overview");
  const views = { overview: Overview, accounts: Accounts, stores: Stores, users: Users, orders: Orders, messages: Messages, jobs: Jobs, audit: Audit };
  const View = views[tab];
  return (
    <div className="space-y-4">
      <PageHeader title="🛡️ Super admin" subtitle="Every account, store, order and message on the platform" />
      <Tabs value={tab} onChange={setTab} tabs={Object.keys(views).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
      <View />
    </div>
  );
}
