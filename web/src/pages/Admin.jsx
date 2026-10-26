import { useEffect, useState } from "react";
import { AlertTriangle, Building2, CreditCard, FileBarChart2, FileDown, Layers, MessageCircle, Package, Send, ShieldCheck, Sparkles, Store, Wallet } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApi, post, patch, put, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { dateTime, num, money, ago, STATUS_LABEL, STATUS_TONE } from "../lib/format.js";
import { Card, Stat, Table, Badge, Button, Field, Modal, PageHeader, Tabs, Input, Loading, ErrorBox, Select, Textarea, Toggle, useAction } from "../components/ui.jsx";
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
        <Stat icon={Building2} label="Accounts" value={num(t.accounts)} sub={`${num(t.suspended)} suspended · ${num(t.users)} users`} />
        <Stat icon={Store} label="Stores" value={num(t.stores)} sub={`${num(t.active_stores)} active · ${num(t.numbers)} WhatsApp numbers`} />
        <Stat icon={Package} label="Orders (30d)" value={num(k.orders)} sub={`${k.confirmation_rate}% confirmed`} tone="green" />
        <Stat icon={MessageCircle} label="Messages (30d)" value={num(m.sent)} sub={`${m.read_rate}% read · ${num(m.failed)} failed`} />
        <Stat icon={Layers} label="Queue backlog" value={num(t.queue_backlog)} tone={Number(t.queue_backlog) > 100 ? "amber" : "gray"} />
        <Stat icon={AlertTriangle} label="Failed jobs (24h)" value={num(t.failed_jobs_24h)} tone={Number(t.failed_jobs_24h) ? "red" : "gray"} />
        <Stat icon={Sparkles} label="AI calls (30d)" value={num(data.metrics.ai.calls)} sub={`${num(data.metrics.ai.tokens)} tokens`} tone="blue" />
        <Stat icon={Wallet} label="Est. Meta cost (30d)" value={money(m.cost, "USD")} />
      </div>
      <PlatformReport />
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

function PlatformReport() {
  const { data, error, reload } = useApi("/admin/platform-report");
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    if (data) setF({ ...data.settings, senderStoreId: data.settings.senderStoreId ?? null });
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!f) return null;
  return (
    <Card title="Your daily platform report on WhatsApp" icon={FileBarChart2}>
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <p className="text-sm text-gray-500">One PDF every day covering every business and store: orders, revenue, confirmation rate, messages, failures and the top stores.</p>
          <Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Send me the platform report every day" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="My WhatsApp number" className="sm:col-span-2">
              <Input value={f.phone || ""} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+92 300 1234567" type="tel" />
            </Field>
            <Field label="Time">
              <Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
            </Field>
          </div>
          <Field label="Send from" hint="The WhatsApp number of this store sends the report.">
            <Select value={f.senderStoreId ?? ""} onChange={(e) => setF({ ...f, senderStoreId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">First store with a WhatsApp number</option>
              {data.senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.display_number || "QR"} {s.provider === "gateway" ? "(QR)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => run(() => put("/admin/platform-report", { enabled: f.enabled, phone: f.phone || "", time: f.time, senderStoreId: f.senderStoreId }), "Saved").then(reload)}>
              Save
            </Button>
            <Button variant="secondary" loading={busy} disabled={!f.phone} onClick={() => run(() => post("/admin/platform-report/send"), "Report sent to your WhatsApp").then(reload)}>
              <Send className="h-4 w-4" /> Send now
            </Button>
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Recent reports</div>
          {data.history.length === 0 ? (
            <p className="text-sm text-gray-400">No reports yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100 rounded-xl ring-1 ring-gray-100 dark:divide-gray-800 dark:ring-gray-800">
              {data.history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div>
                    <div className="font-medium">{h.period_key}</div>
                    <div className="text-xs text-gray-500">
                      {num(h.kpis?.orders)} orders · {h.kpis?.confirmation_rate ?? 0}% confirmed · {(h.sent_to || []).length ? "sent" : "not sent"}
                    </div>
                  </div>
                  <a href={`/api/admin/platform-report/${h.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-400">
                    <FileDown className="h-3.5 w-3.5" /> PDF
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function PlanModal({ account, onClose, onDone }) {
  const plans = useApi("/admin/plans");
  const [f, setF] = useState({
    plan: account.plan,
    plan_status: account.plan_status,
    paid_until: account.paid_until ? String(account.paid_until).slice(0, 10) : "",
    trial_ends_at: account.trial_ends_at ? String(account.trial_ends_at).slice(0, 10) : "",
  });
  const [run, busy] = useAction();
  return (
    <Modal
      open
      onClose={onClose}
      title={`Plan for ${account.name}`}
      footer={
        <Button loading={busy} onClick={() => run(() => patch(`/admin/accounts/${account.id}`, { ...f, paid_until: f.paid_until || null, trial_ends_at: f.trial_ends_at || null }), "Plan updated").then(() => (onDone(), onClose()))}>
          Save
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Plan">
          <Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
            {(plans.data?.plans || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {!plans.data?.plans?.some((p) => p.id === f.plan) && <option value={f.plan}>{f.plan}</option>}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={f.plan_status} onChange={(e) => setF({ ...f, plan_status: e.target.value })} options={["trialing", "active", "past_due", "canceled"]} />
        </Field>
        <Field label="Paid until" hint="For bank / wallet payments">
          <Input type="date" value={f.paid_until} onChange={(e) => setF({ ...f, paid_until: e.target.value })} />
        </Field>
        <Field label="Trial ends">
          <Input type="date" value={f.trial_ends_at} onChange={(e) => setF({ ...f, trial_ends_at: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function Plans() {
  const { data, reload } = useApi("/admin/plans");
  const [run, busy] = useAction();
  const [billing, setBilling] = useState(null);
  const [edit, setEdit] = useState(null);
  useEffect(() => {
    if (data) setBilling(data.settings);
  }, [data]);
  if (!data || !billing) return <Loading />;
  return (
    <div className="space-y-4">
      <Card title="Billing" icon={CreditCard} actions={<Button size="sm" loading={busy} onClick={() => run(() => put("/admin/billing", billing), "Saved").then(reload)}>Save</Button>}>
        <div className="space-y-3">
          <Toggle checked={billing.enabled} onChange={(v) => setBilling({ ...billing, enabled: v })} label="Charge businesses with plans and limits" hint="Off = everything unlimited (good for running only your own stores)." />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Free trial days">
              <Input type="number" value={billing.trialDays} onChange={(e) => setBilling({ ...billing, trialDays: Number(e.target.value) })} />
            </Field>
            <Field label="Support contact" className="sm:col-span-2">
              <Input value={billing.contact} onChange={(e) => setBilling({ ...billing, contact: e.target.value })} placeholder="WhatsApp or email for receipts" />
            </Field>
          </div>
          <Field label="Bank / JazzCash / Easypaisa instructions" hint="Shown on every business's Billing page">
            <Textarea value={billing.bankInstructions} onChange={(e) => setBilling({ ...billing, bankInstructions: e.target.value })} />
          </Field>
          <p className="text-xs text-gray-500">Card payments: {data.stripe ? "Stripe is connected ✅" : "add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, then a Stripe price ID per plan."}</p>
        </div>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.plans.map((p) => (
          <Card key={p.id} title={p.name} actions={<Button size="sm" variant="ghost" onClick={() => setEdit({ ...p, features: (p.features || []).join("\n") })}>Edit</Button>}>
            <div className="text-2xl font-bold">
              {p.currency} {num(p.price)}
            </div>
            <div className="mt-2 space-y-0.5 text-xs text-gray-500">
              <div>Stores: {p.limits.stores ?? "∞"}</div>
              <div>Messages / month: {p.limits.messages ? num(p.limits.messages) : "∞"}</div>
              <div>AI replies / month: {p.limits.aiReplies ? num(p.limits.aiReplies) : "∞"}</div>
              <div>Users: {p.limits.users ?? "∞"}</div>
              <div>{p.active ? "Visible" : "Hidden"} · Stripe: {p.stripe_price_id || "—"}</div>
            </div>
          </Card>
        ))}
      </div>
      <Button variant="secondary" onClick={() => setEdit({ id: "", name: "", price: 0, currency: "USD", limits: {}, features: "", stripe_price_id: "", active: true, sort: data.plans.length, isNew: true })}>
        Add plan
      </Button>
      {edit && (
        <Modal
          open
          onClose={() => setEdit(null)}
          title={edit.isNew ? "New plan" : `Edit ${edit.name}`}
          footer={
            <Button
              loading={busy}
              disabled={!edit.id || !edit.name}
              onClick={() =>
                run(
                  () =>
                    put(`/admin/plans/${edit.id}`, {
                      name: edit.name,
                      price: Number(edit.price),
                      currency: edit.currency,
                      limits: Object.fromEntries(["stores", "messages", "aiReplies", "users"].map((k) => [k, edit.limits[k] === "" || edit.limits[k] === undefined ? null : Number(edit.limits[k])])),
                      features: String(edit.features).split("\n").map((x) => x.trim()).filter(Boolean),
                      stripe_price_id: edit.stripe_price_id || null,
                      active: edit.active,
                      sort: Number(edit.sort || 0),
                    }),
                  "Plan saved"
                ).then(() => (setEdit(null), reload()))
              }
            >
              Save
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {edit.isNew && (
              <Field label="Plan ID" hint="lowercase, e.g. business">
                <Input value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
              </Field>
            )}
            <Field label="Name">
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Price per month">
              <Input type="number" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} />
            </Field>
            <Field label="Currency">
              <Input value={edit.currency} maxLength={3} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} />
            </Field>
            {[
              ["stores", "Stores"],
              ["messages", "Messages / month"],
              ["aiReplies", "AI replies / month"],
              ["users", "Team members"],
            ].map(([k, label]) => (
              <Field key={k} label={label} hint="Empty = unlimited">
                <Input type="number" value={edit.limits[k] ?? ""} onChange={(e) => setEdit({ ...edit, limits: { ...edit.limits, [k]: e.target.value } })} />
              </Field>
            ))}
            <Field label="Stripe price ID" className="sm:col-span-2">
              <Input value={edit.stripe_price_id || ""} onChange={(e) => setEdit({ ...edit, stripe_price_id: e.target.value })} placeholder="price_…" />
            </Field>
            <Field label="Features (one per line)" className="sm:col-span-2">
              <Textarea value={edit.features} onChange={(e) => setEdit({ ...edit, features: e.target.value })} />
            </Field>
            <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Show on the Billing page" />
          </div>
        </Modal>
      )}
    </div>
  );
}

function Accounts() {
  const { data, reload } = useApi("/admin/accounts");
  const [run] = useAction();
  const [planFor, setPlanFor] = useState(null);
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
          { key: "plan", label: "Plan", render: (a) => <button className="text-left hover:underline" onClick={() => setPlanFor(a)}><div className="font-medium capitalize">{a.plan}</div><div className="text-xs text-gray-500">{a.plan_status}{a.paid_until ? ` · until ${String(a.paid_until).slice(0, 10)}` : ""}</div></button> },
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
      {planFor && <PlanModal account={planFor} onClose={() => setPlanFor(null)} onDone={reload} />}
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
  const views = { overview: Overview, accounts: Accounts, plans: Plans, stores: Stores, users: Users, orders: Orders, messages: Messages, jobs: Jobs, audit: Audit };
  const View = views[tab];
  return (
    <div className="space-y-4">
      <PageHeader icon={ShieldCheck} title="Super admin" subtitle="Every account, store, order and message on the platform" />
      <Tabs value={tab} onChange={setTab} tabs={Object.keys(views).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
      <View />
    </div>
  );
}
