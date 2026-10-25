import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, get, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago } from "../lib/format.js";
import { Card, Badge, Button, PageHeader, Modal, Field, Input, Tabs, Empty, ErrorBox, useAction } from "../components/ui.jsx";

function ConnectModal({ onClose, onDone, oauth }) {
  const [tab, setTab] = useState(oauth ? "oauth" : "manual");
  const [f, setF] = useState({ shopDomain: "", accessToken: "", webhookSecret: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (tab === "oauth") {
        const r = await get(`/shopify/install?shop=${encodeURIComponent(f.shopDomain)}`);
        window.location.href = r.url;
        return;
      }
      const store = await post("/stores", f);
      onDone(store);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Connect a Shopify store" footer={<Button loading={busy} onClick={submit}>{tab === "oauth" ? "Continue to Shopify" : "Connect"}</Button>}>
      <Tabs value={tab} onChange={setTab} tabs={[...(oauth ? [{ value: "oauth", label: "Install app (recommended)" }] : []), { value: "manual", label: "Custom app token" }]} />
      <div className="mt-4 space-y-3">
        <Field label="Store domain" hint="e.g. glowcandles.myshopify.com">
          <Input value={f.shopDomain} onChange={(e) => setF({ ...f, shopDomain: e.target.value })} placeholder="yourstore.myshopify.com" />
        </Field>
        {tab === "manual" && (
          <>
            <Field label="Admin API access token" hint="From your custom app (starts with shpat_). Needs order, customer, product, fulfillment, checkout and discount scopes.">
              <Input value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} type="password" />
            </Field>
            <Field label="API secret key" hint="Used to verify webhooks from this store.">
              <Input value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} type="password" />
            </Field>
          </>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export default function Stores() {
  const { me, can, refresh } = useSession();
  const navigate = useNavigate();
  const { data, error, reload } = useApi("/stores", { interval: 30000 });
  const [connecting, setConnecting] = useState(false);
  const [run] = useAction();
  const [accountName, setAccountName] = useState("");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stores"
        subtitle="Each store has its own Shopify connection, WhatsApp number, templates, settings and reports."
        actions={can("admin") && <Button onClick={() => setConnecting(true)}>Connect store</Button>}
      />
      <ErrorBox error={error} />
      {data?.length === 0 && <Empty title="No stores yet" action={can("admin") && <Button onClick={() => setConnecting(true)}>Connect your first store</Button>} />}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((s) => (
          <Card key={s.id}>
            <button className="block w-full text-left" onClick={() => navigate(`/stores/${s.id}`)}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-gray-500">{s.shopify_domain}</div>
                </div>
                <Badge tone={s.status === "active" ? "green" : "red"}>{s.status}</Badge>
              </div>
              <div className="mt-3 space-y-1 text-sm">
                <div>{s.display_number ? `📱 ${s.display_number}` : <span className="text-amber-600">⚠️ No WhatsApp number linked</span>}</div>
                {s.quality_rating && <div className="text-xs text-gray-500">Quality: {s.quality_rating}</div>}
                <div className="text-xs text-gray-500">
                  {s.orders_24h} orders today · {s.awaiting} awaiting reply · synced {ago(s.last_reconciled_at)}
                </div>
                {Number(s.failed_jobs) > 0 && <div className="text-xs text-red-600">{s.failed_jobs} failed tasks this week</div>}
              </div>
            </button>
          </Card>
        ))}
      </div>
      <Card title="Add another business">
        <p className="mb-2 text-sm text-gray-500">Run a separate business with its own team and stores under the same login.</p>
        <div className="flex gap-2">
          <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Business name" />
          <Button variant="secondary" disabled={!accountName} onClick={() => run(() => post("/auth/accounts", { name: accountName }), "Business created").then(refresh)}>
            Create
          </Button>
        </div>
      </Card>
      {connecting && (
        <ConnectModal
          oauth={me?.features?.shopifyOAuth}
          onClose={() => setConnecting(false)}
          onDone={async (s) => {
            setConnecting(false);
            await refresh();
            reload();
            navigate(`/stores/${s.id}`);
          }}
        />
      )}
    </div>
  );
}
