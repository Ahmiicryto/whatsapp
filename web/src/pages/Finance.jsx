import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Banknote, Boxes, HandCoins, Landmark, Megaphone, RotateCcw, Truck } from "lucide-react";
import { useApi, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago, compact, money, num } from "../lib/format.js";
import { Badge, Card, ErrorBox, Loading, PageHeader, Select, Stat, Table } from "../components/ui.jsx";
import { TrendChart } from "../components/charts.jsx";

const RANGES = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

function Row({ label, value, sub, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-sm text-gray-600 dark:text-gray-300">
        {label}
        {sub && <span className="ml-1 text-xs text-gray-400">{sub}</span>}
      </span>
      <span className={strong ? "text-base font-bold tabular-nums" : "text-sm font-semibold tabular-nums"}>{value}</span>
    </div>
  );
}

export default function Finance() {
  const { storeId, stores } = useSession();
  const [days, setDays] = useState(30);
  const { data, error } = useApi(`/finance${qs({ storeId, days })}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const m = (v) => money(v, data.currency);
  const { cash, receivable, losses, ads, stock } = data;
  const roas = ads.spend ? Math.round((ads.purchaseValue / ads.spend) * 100) / 100 : null;
  const firstStore = storeId !== "all" ? storeId : stores[0]?.id;
  return (
    <div className="space-y-5">
      <PageHeader icon={Landmark} title="Finance" subtitle="Every amount in one place: cash in, money owed to you, stock and ads" actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))} options={RANGES} className="w-40" />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={Banknote} label="Cash received" value={m(cash.total)} sub={`COD ${compact(cash.codCollected)} · advances ${compact(cash.advancesCollected)} · prepaid ${compact(cash.prepaid)}`} tone="green" />
        <Stat icon={HandCoins} label="Couriers owe you" value={m(receivable.dueFromCouriers)} sub={`${num(receivable.dueCount)} delivered parcels not paid yet`} tone="amber" />
        <Stat icon={Truck} label="Cash on the road" value={m(receivable.onRoad)} sub={`${num(receivable.onRoadCount)} parcels out for delivery`} tone="blue" />
        <Stat icon={Megaphone} label="Ad spend" value={m(ads.spend)} sub={roas ? `Meta ROAS ${roas}× · ${num(ads.purchases)} purchases` : `${num(ads.clicks)} clicks`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Stock value" icon={Boxes}>
          <Row label="At cost" value={m(stock.atCost)} strong />
          <Row label="At selling price" value={m(stock.atRetail)} />
          <Row label="Units in stock" value={num(stock.units)} />
          <Row label="Low stock (≤5)" value={num(stock.lowStock)} />
          <Row label="Out of stock" value={num(stock.outOfStock)} />
          {stock.missingCost > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {stock.missingCost} products have no cost, so the value at cost is too low. <Link to="/products" className="font-semibold underline">Set costs</Link>
            </p>
          )}
        </Card>
        <Card title="Money still to come" icon={HandCoins}>
          <Row label="Due from couriers" value={m(receivable.dueFromCouriers)} />
          <Row label="On the road (COD)" value={m(receivable.onRoad)} />
          <Row label="Advances requested" value={m(receivable.advancesPending)} sub={`${receivable.advancesPendingCount} orders`} />
          <div className="mt-1 border-t border-gray-100 pt-1 dark:border-gray-800">
            <Row label="Total expected" value={m(receivable.dueFromCouriers + receivable.onRoad + receivable.advancesPending)} strong />
          </div>
          <Link to="/shipments?tab=cod" className="mt-2 inline-block text-xs font-semibold text-brand-700 hover:underline dark:text-brand-400">
            Settle courier payments →
          </Link>
        </Card>
        <Card title="Losses & costs" icon={RotateCcw}>
          <Row label="Returned parcels" value={m(losses.returnedValue)} sub={`${losses.returnedCount} parcels`} />
          <Row label="Returns not back yet" value={num(losses.returnsNotReceived)} />
          <Row label="Courier fees" value={m(losses.courierFees)} />
          <Row label="Ads" value={m(ads.spend)} />
          {losses.returnsNotReceived > 0 && (
            <Link to="/scan" className="mt-2 inline-block text-xs font-semibold text-brand-700 hover:underline dark:text-brand-400">
              Scan returns as they arrive →
            </Link>
          )}
        </Card>
      </div>
      <Card title="Cash received vs delivered vs ad spend">
        <TrendChart
          data={data.series}
          series={[
            { key: "collected", label: "Cash received" },
            { key: "delivered", label: "Delivered (COD value)" },
            { key: "ads", label: "Ad spend" },
          ]}
          format={(v) => compact(v)}
        />
      </Card>
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="By courier" padded={false}>
          <Table
            columns={[
              { key: "courier", label: "Courier" },
              { key: "due", label: "Owes you", render: (c) => <span className="font-semibold">{m(c.due)}</span> },
              { key: "due_count", label: "Parcels", render: (c) => num(c.due_count) },
              { key: "oldest", label: "Oldest unpaid", render: (c) => (c.oldest_due ? <span className={Date.now() - new Date(c.oldest_due) > 10 * 86400000 ? "font-semibold text-red-600" : ""}>{ago(c.oldest_due)}</span> : "—") },
              { key: "onRoad", label: "On the road", render: (c) => m(c.onRoad) },
              { key: "collected", label: `Paid (${days}d)`, render: (c) => m(c.collected) },
            ]}
            rows={data.couriers}
            empty="No shipments yet"
          />
        </Card>
        <Card title="Ad spend by channel" icon={Megaphone}>
          {ads.channels.length === 0 ? (
            <p className="text-sm text-gray-500">No ad spend yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {ads.channels.map((c) => (
                <li key={c.channel} className="flex items-center justify-between gap-2">
                  <span>
                    <span className="capitalize">{c.channel}</span> {c.synced && <Badge tone="blue">Synced from Meta</Badge>}
                  </span>
                  <span className="font-semibold tabular-nums">{m(c.spend)}</span>
                </li>
              ))}
            </ul>
          )}
          {firstStore && (
            <Link to={`/stores/${firstStore}?tab=ads`} className="mt-3 inline-block text-xs font-semibold text-brand-700 hover:underline dark:text-brand-400">
              Connect a Meta ad account for automatic spend →
            </Link>
          )}
        </Card>
      </div>
    </div>
  );
}
