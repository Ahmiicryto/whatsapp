import { useState } from "react";
import { AlertTriangle, Megaphone, PiggyBank, Receipt, RotateCcw, TrendingUp, Upload } from "lucide-react";
import { useApi, post, del, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { compact, money, num } from "../lib/format.js";
import { Button, Card, Empty, ErrorBox, Input, Loading, PageHeader, Select, Stat, Table, Textarea, useAction } from "../components/ui.jsx";
import { TrendChart } from "../components/charts.jsx";

const RANGES = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

function AdSpend({ storeId, stores, onChange }) {
  const list = useApi(`/ad-spend${qs({ storeId })}`);
  const [f, setF] = useState({ storeId: storeId !== "all" ? Number(storeId) : stores[0]?.id, day: new Date().toISOString().slice(0, 10), channel: "meta", amount: "" });
  const [csv, setCsv] = useState(null);
  const [run, busy] = useAction();
  const done = () => {
    list.reload();
    onChange();
  };
  return (
    <Card title="Ad spend" icon={Megaphone}>
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-5">
          {storeId === "all" && (
            <Select value={f.storeId} onChange={(e) => setF({ ...f, storeId: Number(e.target.value) })} options={stores.map((s) => ({ value: s.id, label: s.name }))} aria-label="Store" />
          )}
          <Input type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} aria-label="Day" />
          <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} options={[{ value: "meta", label: "Meta" }, { value: "tiktok", label: "TikTok" }, { value: "google", label: "Google" }, { value: "other", label: "Other" }]} aria-label="Channel" />
          <Input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="Amount" aria-label="Amount" />
          <Button loading={busy} disabled={f.amount === ""} onClick={() => run(() => post("/ad-spend", { ...f, amount: Number(f.amount) }), "Saved").then(done)}>
            Add
          </Button>
        </div>
        <button className="flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-400" onClick={() => setCsv(csv === null ? "" : null)}>
          <Upload className="h-3.5 w-3.5" /> Paste a CSV (date, channel, amount)
        </button>
        {csv !== null && (
          <div className="space-y-2">
            <Textarea className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"2026-10-01,meta,4500\n2026-10-02,meta,5200"} />
            <Button size="sm" loading={busy} onClick={() => run(() => post("/ad-spend/import", { storeId: f.storeId, csv }), "Imported").then(() => (setCsv(null), done()))}>
              Import
            </Button>
          </div>
        )}
        <div className="max-h-56 overflow-y-auto">
          <Table
            columns={[
              { key: "day", label: "Day", render: (a) => String(a.day).slice(0, 10) },
              { key: "channel", label: "Channel" },
              { key: "store_name", label: "Store" },
              { key: "amount", label: "Amount", render: (a) => num(a.amount) },
              { key: "x", label: "", render: (a) => <button className="text-xs text-gray-400 hover:text-red-600" onClick={() => run(() => del(`/ad-spend/${a.id}`)).then(done)}>Remove</button> },
            ]}
            rows={list.data || []}
            empty="No ad spend yet"
          />
        </div>
      </div>
    </Card>
  );
}

export default function Profit() {
  const { storeId, stores } = useSession();
  const [days, setDays] = useState(30);
  const { data, error, reload } = useApi(`/profit${qs({ storeId, days })}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.totals;
  const cur = data.currency;
  const m = (v) => money(v, cur);
  const costs = t.cogs + t.shipping + t.returnCost + t.fees + t.packaging + t.ads;
  return (
    <div className="space-y-5">
      <PageHeader icon={TrendingUp} title="Profit" subtitle="What you really keep after every cost" actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))} options={RANGES} className="w-40" />} />
      {t.missingCost > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {num(t.missingCost)} orders contain products without a cost, so profit looks higher than it is. Add "Cost per item" in Shopify or set costs on the Products page.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat icon={Receipt} label="Revenue kept" value={m(t.revenue)} sub={`${num(t.kept)} orders, not cancelled or returned`} />
        <Stat icon={PiggyBank} label="Net profit" value={m(t.profit)} sub={`${t.margin}% margin`} tone={t.profit >= 0 ? "green" : "red"} />
        <Stat icon={Megaphone} label="Ad spend" value={m(t.ads)} sub={t.roas ? `ROAS ${t.roas}×` : "Add your ad spend below"} tone="blue" />
        <Stat icon={RotateCcw} label="Returns" value={`${t.returnRate}%`} sub={`${num(t.returned)} parcels · ${m(t.returnCost)} lost`} tone={t.returnRate > 15 ? "red" : "gray"} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="Revenue, costs and profit per day">
          {data.series.length ? (
            <TrendChart
              data={data.series.map((d) => ({ day: d.day, revenue: Math.round(d.revenue), costs: Math.round(d.cogs + d.shipping + d.returnCost + d.fees + d.packaging + d.ads), profit: Math.round(d.profit) }))}
              series={[
                { key: "revenue", label: "Revenue" },
                { key: "costs", label: "All costs" },
                { key: "profit", label: "Profit" },
              ]}
              format={(v) => compact(v)}
            />
          ) : (
            <Empty title="No orders in this period" />
          )}
        </Card>
        <Card title="Where the money goes">
          <ul className="space-y-2.5 text-sm">
            {[
              ["Product cost", t.cogs],
              ["Courier fees", t.shipping],
              ["Returns", t.returnCost],
              ["COD & other fees", t.fees],
              ["Packaging", t.packaging],
              ["Ads", t.ads],
            ].map(([label, v]) => (
              <li key={label}>
                <div className="flex justify-between">
                  <span>{label}</span>
                  <span className="font-semibold tabular-nums">{m(v)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div className="h-full rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" style={{ width: `${costs ? Math.round((v / costs) * 100) : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Profit by product" padded={false}>
        <Table
          columns={[
            { key: "title", label: "Product", render: (p) => <div className="flex items-center gap-2">{p.image_url && <img src={p.image_url} alt="" className="h-8 w-8 rounded-lg object-cover" />}<span className="font-medium">{p.title}</span></div> },
            { key: "units", label: "Units", render: (p) => num(p.units) },
            { key: "revenue", label: "Revenue", render: (p) => m(p.revenue) },
            { key: "cogs", label: "Cost", render: (p) => (p.missing_cost ? <span className="text-amber-600">missing</span> : m(p.cogs)) },
            { key: "gross", label: "Gross profit", render: (p) => <span className={p.gross < 0 ? "text-red-600" : "text-brand-700 dark:text-brand-400"}>{m(p.gross)}</span> },
            { key: "returnRate", label: "Returned", render: (p) => <span className={p.returnRate > 20 ? "font-semibold text-red-600" : ""}>{p.returnRate}%</span> },
          ]}
          rows={data.products}
          empty="No sales in this period"
        />
      </Card>
      <AdSpend storeId={storeId} stores={stores} onChange={reload} />
    </div>
  );
}
