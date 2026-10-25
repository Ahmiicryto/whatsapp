import { AlertTriangle, CheckCircle2, Clock3, LayoutDashboard, Package, Send, Sparkles, Wallet, XCircle } from "lucide-react";
import { useState } from "react";
import { useApi, qs, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, num, compact, STATUS_LABEL } from "../lib/format.js";
import { Card, Stat, Loading, ErrorBox, PageHeader, Select, Button, Input, Empty } from "../components/ui.jsx";
import { TrendChart, ColumnChart, BarList } from "../components/charts.jsx";
import { Link } from "react-router-dom";

const RANGES = [
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

function AskAi({ storeId }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);
  async function ask(e) {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    try {
      const r = await post("/ai/ask", { question, storeId: storeId === "all" ? "all" : Number(storeId) });
      setAnswer(r.answer);
    } catch (err) {
      setAnswer(`⚠️ ${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="✨ Ask your data">
      <form onSubmit={ask} className="flex gap-2">
        <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which city cancels the most? How did this week compare to last?" />
        <Button loading={busy}>Ask</Button>
      </form>
      {answer && <div className="mt-3 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800/60">{answer}</div>}
    </Card>
  );
}

export default function Dashboard() {
  const { storeId, stores } = useSession();
  const [days, setDays] = useState("30");
  const from = new Date(Date.now() - Number(days) * 86400000);
  if (days === "1") from.setHours(0, 0, 0, 0);
  const { data, error, loading } = useApi(`/dashboard${qs({ storeId, from: from.toISOString().slice(0, 13) + ":00:00Z" })}`, { interval: 60000 });

  if (!stores.length) {
    return (
      <Empty title="Connect your first Shopify store" action={<Link to="/stores"><Button>Connect store</Button></Link>}>
        Link a store and a WhatsApp number to start confirming orders automatically.
      </Empty>
    );
  }
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const k = data.kpis;
  const m = data.messages;
  const cur = data.currency;
  const fmtMoney = (v) => money(v, cur);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        subtitle={storeId === "all" ? `All ${stores.length} stores` : stores.find((s) => String(s.id) === storeId)?.name}
        actions={<Select value={days} onChange={(e) => setDays(e.target.value)} options={RANGES} className="w-40" />}
      />
      {loading && <div className="text-xs text-gray-400">Refreshing…</div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={Package} label="Orders" value={num(k.orders)} sub={`${num(k.cod)} cash on delivery`} />
        <Stat icon={Wallet} label="Revenue" value={money(k.revenue, cur)} sub={`AOV ${money(k.aov, cur)}`} />
        <Stat icon={CheckCircle2} label="Confirmed" value={`${k.confirmation_rate}%`} tone="green" sub={`${num(k.confirmed)} confirmed on WhatsApp`} />
        <Stat icon={XCircle} label="Cancelled" value={`${k.cancel_rate}%`} tone="red" sub={`${num(k.cancelled_by_customer)} by customers`} />
        <Stat icon={Clock3} label="Awaiting reply" value={num(k.awaiting)} tone="amber" sub={`${num(k.no_response)} no response`} />
        <Stat icon={Send} label="Messages sent" value={num(m.sent)} sub={`${m.delivery_rate}% delivered · ${m.read_rate}% read`} />
        <Stat icon={Sparkles} label="AI replies" value={num(m.ai_replies)} tone="blue" sub={`${num(m.received)} customer messages`} />
        <Stat icon={AlertTriangle} label="Needs attention" value={num(k.needs_attention)} tone={Number(k.needs_attention) ? "red" : "gray"} sub={`${num(k.high_risk)} high risk orders`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Orders per day">
          <TrendChart
            data={data.series.map((d) => ({ ...d, orders: Number(d.orders), confirmed: Number(d.confirmed), cancelled: Number(d.cancelled) }))}
            series={[
              { key: "orders", label: "Orders" },
              { key: "confirmed", label: "Confirmed" },
              { key: "cancelled", label: "Cancelled" },
            ]}
          />
        </Card>
        <Card title="Revenue per day">
          <ColumnChart data={data.series.map((d) => ({ ...d, revenue: Number(d.revenue) }))} dataKey="revenue" label="Revenue" format={fmtMoney} axisFormat={compact} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Confirmation funnel">
          <BarList
            rows={[
              { label: "Orders", value: Number(k.orders) },
              { label: "Confirmation sent", value: Number(k.confirmation_sent) },
              { label: "Confirmed", value: Number(k.confirmed) },
              { label: "Shipped", value: Number(k.shipped) },
              { label: "Delivered", value: Number(k.delivered) },
            ]}
          />
        </Card>
        <Card title="WhatsApp messages">
          <BarList
            rows={[
              { label: "Sent", value: Number(m.sent) },
              { label: "Delivered", value: Number(m.delivered) },
              { label: "Read", value: Number(m.read) },
              { label: "Customer replies", value: Number(m.received) },
              { label: "Failed", value: Number(m.failed) },
            ]}
          />
          <div className="mt-3 text-xs text-gray-500">Estimated Meta cost: {money(m.cost, "USD")}</div>
        </Card>
        <Card title="Order status">
          <BarList rows={data.statuses.map((s) => ({ label: STATUS_LABEL[s.status] || s.status, value: Number(s.n) }))} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Top products">
          <BarList rows={data.topProducts.map((p) => ({ label: p.title, value: Number(p.qty), display: `${num(p.qty)} · ${money(p.revenue, cur)}`, image: p.image }))} />
        </Card>
        <Card title="Top cities">
          <BarList rows={data.topCities.map((c) => ({ label: c.city, value: Number(c.orders), display: `${num(c.orders)} (${num(c.cancelled)} cancelled)` }))} />
        </Card>
        <Card title="Address quality">
          <BarList
            rows={["80-100", "50-79", "0-49", "unchecked"].map((b) => ({
              label: b === "unchecked" ? "Not checked" : `Score ${b}`,
              value: Number(data.addressBuckets.find((x) => x.bucket === b)?.n || 0),
            }))}
          />
          <div className="mt-3 text-xs text-gray-500">
            {num(k.address_updated)} fixed by customers on WhatsApp · {num(k.address_verified)} verified
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Marketing">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-gray-500">Campaign messages</div>
              <div className="text-lg font-semibold">{num(data.campaigns.sent)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Link clicks</div>
              <div className="text-lg font-semibold">{num(data.campaigns.clicked)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Campaign revenue</div>
              <div className="text-lg font-semibold">{money(data.campaigns.revenue, cur)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Recovered carts</div>
              <div className="text-lg font-semibold">
                {num(data.carts.recovered)} · {money(data.carts.recovered_revenue, cur)}
              </div>
            </div>
          </div>
        </Card>
        <Card title="Order map">
          {data.mapUrl ? (
            <img src={data.mapUrl} alt="Map of recent order delivery locations" className="w-full rounded-lg" />
          ) : (
            <div className="py-8 text-center text-sm text-gray-500">Add a Google Maps API key to see where your orders go.</div>
          )}
        </Card>
      </div>

      <AskAi storeId={storeId} />
    </div>
  );
}
