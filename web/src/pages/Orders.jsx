import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, dateTime, STATUS_LABEL, STATUS_TONE, ADDRESS_LABEL, ADDRESS_TONE } from "../lib/format.js";
import { Card, Table, Badge, Input, Select, Button, PageHeader, ErrorBox } from "../components/ui.jsx";

const STATUSES = [{ value: "", label: "All statuses" }, ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))];

export default function Orders() {
  const { storeId } = useSession();
  const navigate = useNavigate();
  const [f, setF] = useState({ q: "", status: "", payment: "", address: "", risk: "", attention: "", page: 1 });
  const params = qs({ storeId, ...f });
  const { data, error, loading } = useApi(`/orders${params}`, { interval: 30000 });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value, page: 1 });

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle="Synced automatically from Shopify"
        actions={
          <a href={`/api/orders/export.csv${params}`}>
            <Button variant="secondary">Export CSV</Button>
          </a>
        }
      />
      <Card padded={false}>
        <div className="grid gap-2 border-b border-gray-100 p-3 sm:grid-cols-3 lg:grid-cols-6 dark:border-gray-800">
          <Input placeholder="Search order, name, phone, address" value={f.q} onChange={set("q")} className="lg:col-span-2" />
          <Select value={f.status} onChange={set("status")} options={STATUSES} />
          <Select value={f.payment} onChange={set("payment")} options={[{ value: "", label: "All payments" }, { value: "cod", label: "Cash on delivery" }, { value: "prepaid", label: "Prepaid" }]} />
          <Select
            value={f.address}
            onChange={set("address")}
            options={[{ value: "", label: "Any address" }, ...Object.entries(ADDRESS_LABEL).map(([value, label]) => ({ value, label }))]}
          />
          <Select
            value={f.attention || f.risk}
            onChange={(e) => setF({ ...f, attention: e.target.value === "1" ? "1" : "", risk: e.target.value === "high" ? "high" : "", page: 1 })}
            options={[{ value: "", label: "All orders" }, { value: "1", label: "Needs attention" }, { value: "high", label: "High risk" }]}
          />
        </div>
        <ErrorBox error={error} />
        <Table
          onRowClick={(o) => navigate(`/orders/${o.id}`)}
          empty={loading ? "Loading…" : "No orders match these filters"}
          rows={data?.rows || []}
          columns={[
            {
              key: "name",
              label: "Order",
              render: (o) => (
                <div className="flex items-center gap-2">
                  {o.image ? <img src={o.image} alt="" className="h-9 w-9 rounded object-cover" /> : <div className="h-9 w-9 rounded bg-gray-100 dark:bg-gray-800" />}
                  <div>
                    <div className="font-medium">
                      {o.name} {o.needs_attention && <span title="Needs attention">⚠️</span>}
                    </div>
                    {storeId === "all" && <div className="text-xs text-gray-500">{o.store_name}</div>}
                  </div>
                </div>
              ),
            },
            {
              key: "customer",
              label: "Customer",
              render: (o) => (
                <div>
                  <div>{o.customer_name || "—"}</div>
                  <div className="text-xs text-gray-500">{o.phone_e164 || "no phone"}</div>
                </div>
              ),
            },
            { key: "total", label: "Total", render: (o) => <div>{money(o.total, o.currency)}<div className="text-xs text-gray-500">{o.is_cod ? "COD" : "Prepaid"}</div></div> },
            { key: "status", label: "WhatsApp", render: (o) => <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status] || o.status}</Badge> },
            {
              key: "address",
              label: "Address",
              render: (o) => (
                <div className="flex items-center gap-1.5">
                  <Badge tone={ADDRESS_TONE[o.address_status]}>{ADDRESS_LABEL[o.address_status]}</Badge>
                  {o.address_score !== null && <span className="text-xs text-gray-500">{o.address_score}</span>}
                </div>
              ),
            },
            { key: "risk", label: "Risk", render: (o) => (o.risk_score === null ? "—" : <Badge tone={o.risk_score >= 60 ? "red" : o.risk_score >= 30 ? "amber" : "gray"}>{o.risk_score}</Badge>) },
            { key: "date", label: "Date", className: "whitespace-nowrap text-gray-500", render: (o) => dateTime(o.shopify_created_at) },
          ]}
        />
        {data && data.total > data.limit && (
          <div className="flex items-center justify-between border-t border-gray-100 p-3 text-sm dark:border-gray-800">
            <span className="text-gray-500">
              {data.total} orders · page {f.page} of {Math.ceil(data.total / data.limit)}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={f.page * data.limit >= data.total} onClick={() => setF({ ...f, page: f.page + 1 })}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
