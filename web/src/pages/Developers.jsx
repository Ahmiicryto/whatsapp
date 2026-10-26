import { useState } from "react";
import { Code2, KeyRound, Plus, Send, Trash2, Webhook } from "lucide-react";
import { useApi, post, del } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Table, Toggle, useAction } from "../components/ui.jsx";

function Code({ children }) {
  return <pre className="overflow-x-auto rounded-xl bg-navy-950 p-4 text-xs leading-relaxed text-slate-200">{children}</pre>;
}

function Secret({ title, value, onClose, note }) {
  return (
    <Modal open onClose={onClose} title={title} footer={<Button onClick={onClose}>I copied it</Button>}>
      <p className="mb-2 text-sm text-gray-500">{note}</p>
      <div className="flex gap-2">
        <Input readOnly value={value} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
        <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(value)}>
          Copy
        </Button>
      </div>
    </Modal>
  );
}

export default function Developers() {
  const { data, error, reload } = useApi("/developers");
  const [run, busy] = useAction();
  const [tokenName, setTokenName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [hook, setHook] = useState({ url: "", events: [] });
  const [secret, setSecret] = useState(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const base = data.apiBase;
  return (
    <div className="space-y-5">
      <PageHeader icon={Code2} title="Developers" subtitle="Connect your ERP, warehouse, Zapier/Make or your own app" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="API tokens" icon={KeyRound}>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input className="flex-1" value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Token name, e.g. Warehouse app" />
              <Button
                loading={busy}
                disabled={!tokenName}
                onClick={() => run(() => post("/developers/tokens", { name: tokenName, scopes: readOnly ? ["read"] : ["read", "write"] })).then((r) => r && (setSecret({ title: "Your API token", value: r.token, note: "This is the only time it's shown. Keep it secret, like a password." }), setTokenName(""), reload()))}
              >
                <Plus className="h-4 w-4" /> Create
              </Button>
            </div>
            <Toggle checked={readOnly} onChange={setReadOnly} label="Read-only token" />
            <Table
              columns={[
                { key: "name", label: "Name" },
                { key: "prefix", label: "Token", render: (t) => <span className="font-mono text-xs">{t.prefix}…</span> },
                { key: "scopes", label: "Access", render: (t) => (t.scopes.includes("write") ? "Read & write" : "Read only") },
                { key: "last", label: "Last used", render: (t) => (t.revoked_at ? <Badge tone="red">Revoked</Badge> : t.last_used_at ? ago(t.last_used_at) : "Never") },
                { key: "x", label: "", render: (t) => !t.revoked_at && <Button size="sm" variant="ghost" aria-label="Revoke" onClick={() => confirm("Revoke this token? Apps using it stop working.") && run(() => del(`/developers/tokens/${t.id}`), "Revoked").then(reload)}><Trash2 className="h-3.5 w-3.5" /></Button> },
              ]}
              rows={data.tokens}
              empty="No tokens yet"
            />
          </div>
        </Card>
        <Card title="Webhooks" icon={Webhook}>
          <div className="space-y-3">
            <Field label="Your URL (https)">
              <Input value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://example.com/wa-events" />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {data.events.map((ev) => (
                <button
                  key={ev}
                  type="button"
                  onClick={() => setHook({ ...hook, events: hook.events.includes(ev) ? hook.events.filter((x) => x !== ev) : [...hook.events, ev] })}
                  className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${hook.events.includes(ev) ? "bg-brand-600 text-white ring-brand-600" : "ring-gray-200 hover:bg-gray-50 dark:ring-gray-700 dark:hover:bg-gray-800"}`}
                >
                  {ev}
                </button>
              ))}
            </div>
            <Button loading={busy} disabled={!hook.url || !hook.events.length} onClick={() => run(() => post("/developers/webhooks", hook)).then((r) => r && (setSecret({ title: "Webhook signing secret", value: r.secret, note: "Check the X-WA-Signature header: hex HMAC-SHA256 of the raw request body with this secret." }), setHook({ url: "", events: [] }), reload()))}>
              <Plus className="h-4 w-4" /> Add webhook
            </Button>
            <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-800">
              {data.webhooks.map((w) => (
                <li key={w.id} className="flex items-start gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{w.url}</div>
                    <div className="text-xs text-gray-500">{w.events.join(", ")}</div>
                    <div className="text-xs">{w.last_sent_at ? (w.last_error ? <span className="text-red-600">Last: {w.last_error}</span> : <span className="text-brand-700">Last delivery OK ({ago(w.last_sent_at)})</span>) : <span className="text-gray-400">Not used yet</span>}</div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => run(() => post(`/developers/webhooks/${w.id}/test`), "Test event sent").then(() => setTimeout(reload, 1500))}>
                    <Send className="h-3.5 w-3.5" /> Test
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => run(() => del(`/developers/webhooks/${w.id}`), "Deleted").then(reload)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
      <Card title="API quick start">
        <div className="space-y-4 text-sm">
          <p>
            Base URL <code className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">{base}</code>. Send <code className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">Authorization: Bearer YOUR_TOKEN</code>. Max 120 requests per minute.
          </p>
          <Code>{`# Latest confirmed orders
curl -H "Authorization: Bearer $TOKEN" "${base}/orders?status=confirmed&limit=20"

# One order with items and shipments
curl -H "Authorization: Bearer $TOKEN" ${base}/orders/123

# Book the courier for an order
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"weight_kg":0.5}' ${base}/orders/123/book

# Send a WhatsApp message (text inside the 24h window, or a template by name/kind)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"store_id":1,"phone":"03001234567","text":"Your order is packed!"}' ${base}/messages

# Check a phone number's delivery record before shipping
curl -H "Authorization: Bearer $TOKEN" "${base}/fraud/lookup?phone=03001234567"`}</Code>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            {[
              ["GET /stores", "Your stores"],
              ["GET /orders", "status, since, phone, store_id, page, limit"],
              ["GET /orders/:id", "Order with items and shipments"],
              ["POST /orders/:id/confirm | cancel | book", "Act on an order"],
              ["GET /shipments", "status, store_id, page"],
              ["GET /customers", "phone, store_id, page"],
              ["GET /products", "q, store_id, page"],
              ["POST /messages", "store_id, phone, text | template, variables"],
              ["GET /fraud/lookup", "phone"],
            ].map(([e, d]) => (
              <div key={e} className="rounded-xl bg-gray-50 p-2 dark:bg-gray-800/50">
                <div className="font-mono font-semibold">{e}</div>
                <div className="text-gray-500">{d}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>
      {secret && <Secret {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}
