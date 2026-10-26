import { useState } from "react";
import { Link } from "react-router-dom";
import { Ban, Search, ShieldAlert, ShieldCheck, Trash2, Wallet } from "lucide-react";
import { useApi, get, post, del, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, num, ago } from "../lib/format.js";
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Stat, Table, Toggle, useAction } from "../components/ui.jsx";
import { ReputationBadge } from "../components/ShipmentPanel.jsx";

export default function Fraud() {
  const { storeId, me, can } = useSession();
  const summary = useApi(`/fraud/summary${qs({ storeId })}`);
  const list = useApi("/fraud/blocklist");
  const [phone, setPhone] = useState("");
  const [lookup, setLookup] = useState(null);
  const [lookupError, setLookupError] = useState(null);
  const [block, setBlock] = useState({ phone: "", reason: "", platform: false });
  const [run, busy] = useAction();
  const s = summary.data;

  async function check() {
    setLookupError(null);
    try {
      setLookup(await get(`/fraud/lookup?phone=${encodeURIComponent(phone)}`));
    } catch (e) {
      setLookup(null);
      setLookupError(e);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader icon={ShieldAlert} title="Fraud protection" subtitle="Stop fake orders and returns before you ship" />
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat icon={ShieldAlert} label="High-risk orders (30d)" value={num(s.high_risk)} sub={`of ${num(s.orders)} orders`} tone={s.high_risk ? "amber" : "gray"} />
          <Stat icon={Ban} label="Blocked numbers" value={num(s.blocked_numbers)} sub={`${num(s.blocked_orders)} orders caught`} tone="red" />
          <Stat icon={ShieldCheck} label="Returned (30d)" value={num(s.returned)} sub={s.orders ? `${Math.round((s.returned / s.orders) * 100)}% return rate` : ""} />
          <Stat icon={Wallet} label="Advances collected" value={money(s.advance_collected, me?.stores?.[0]?.currency)} sub={`${num(s.advance_paid)} orders`} tone="green" />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Check a phone number" icon={Search}>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && check()} placeholder="0300 1234567" type="tel" />
              <Button onClick={check} disabled={!phone}>
                Check
              </Button>
            </div>
            <ErrorBox error={lookupError} />
            {lookup && (
              <>
                <div className="text-sm font-semibold">{lookup.phone}</div>
                <ReputationBadge rep={lookup} />
                <p className="text-xs text-gray-500">The record covers every store on the platform; other stores' names are kept private.</p>
              </>
            )}
          </div>
        </Card>
        <Card title="Block a number" icon={Ban}>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Phone">
                <Input value={block.phone} onChange={(e) => setBlock({ ...block, phone: e.target.value })} type="tel" />
              </Field>
              <Field label="Reason">
                <Input value={block.reason} onChange={(e) => setBlock({ ...block, reason: e.target.value })} placeholder="Refused 3 parcels" />
              </Field>
            </div>
            {me?.user?.isSuperAdmin && <Toggle checked={block.platform} onChange={(v) => setBlock({ ...block, platform: v })} label="Block for every business on the platform" />}
            <Button
              variant="danger"
              disabled={!block.phone || !can("agent")}
              loading={busy}
              onClick={() => run(() => post("/fraud/blocklist", block), "Number blocked").then((r) => r && (setBlock({ phone: "", reason: "", platform: false }), list.reload(), summary.reload()))}
            >
              Block
            </Button>
          </div>
        </Card>
      </div>
      <Card title="High-risk orders (last 30 days)" padded={false}>
        <Table
          columns={[
            { key: "name", label: "Order", render: (o) => <Link to={`/orders/${o.id}`} className="font-semibold text-brand-700 hover:underline dark:text-brand-400">{o.name}</Link> },
            { key: "customer", label: "Customer", render: (o) => <div><div>{o.customer_name}</div><div className="text-xs text-gray-500">{o.phone_e164}</div></div> },
            { key: "total", label: "Total", render: (o) => money(o.total, o.currency) },
            { key: "risk", label: "Risk", render: (o) => <Badge tone="red">{o.risk_score}</Badge> },
            { key: "why", label: "Why", render: (o) => <span className="text-xs text-gray-500">{(o.risk_reasons || []).slice(0, 2).join(" · ")}</span> },
            { key: "advance", label: "Advance", render: (o) => (o.advance_status !== "none" ? <Badge tone={o.advance_status === "paid" ? "green" : "amber"}>{o.advance_status}</Badge> : "—") },
          ]}
          rows={s?.risky || []}
          empty="No high-risk orders 🎉"
        />
      </Card>
      <Card title="Blocklist" padded={false}>
        <Table
          columns={[
            { key: "phone_e164", label: "Number" },
            { key: "reason", label: "Reason", render: (b) => b.reason || "—" },
            { key: "source", label: "Added by", render: (b) => (b.source === "auto_returns" ? <Badge tone="amber">Automatic</Badge> : b.account_id ? b.created_by_email || "Team" : <Badge tone="purple">Platform</Badge>) },
            { key: "created_at", label: "When", render: (b) => ago(b.created_at) },
            {
              key: "x",
              label: "",
              render: (b) =>
                can("admin") && (b.account_id || me?.user?.isSuperAdmin) && (
                  <Button size="sm" variant="ghost" aria-label="Unblock" onClick={() => run(() => del(`/fraud/blocklist/${b.id}`), "Unblocked").then(list.reload)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ),
            },
          ]}
          rows={list.data || []}
          empty="No blocked numbers"
        />
      </Card>
    </div>
  );
}
