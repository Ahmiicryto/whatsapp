import { AlertTriangle, Smartphone, Store } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago } from "../lib/format.js";
import { Card, Badge, Button, PageHeader, Modal, Field, Input, Tabs, Empty, ErrorBox, useAction } from "../components/ui.jsx";

function ConnectModal({ onClose, onDone, oauth, appUrl, redirectUrl }) {
  const [tab, setTab] = useState(oauth ? "oauth" : "manual");
  const [f, setF] = useState({ shopDomain: "", accessToken: "", webhookSecret: "", clientId: "", clientSecret: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (tab === "oauth") {
        let shop = f.shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (shop && !shop.includes(".")) shop = `${shop}.myshopify.com`;
        // Signed in, so the store links to this account automatically after approving in Shopify.
        window.location.href = `/shopify/install?shop=${encodeURIComponent(shop)}`;
        return;
      }
      if (tab === "ownapp") {
        const r = await post("/stores/shopify-app", { shopDomain: f.shopDomain, clientId: f.clientId, clientSecret: f.clientSecret });
        window.location.href = r.installUrl;
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
    <Modal open onClose={onClose} title="Connect a Shopify store" footer={<Button loading={busy} onClick={submit}>{tab === "manual" ? "Connect" : "Continue to Shopify"}</Button>}>
      <Tabs value={tab} onChange={setTab} tabs={[...(oauth ? [{ value: "oauth", label: "Install app" }] : []), { value: "ownapp", label: "Store's own app" }, { value: "manual", label: "Custom app token" }]} />
      {tab === "oauth" && (
        <p className="mt-3 rounded-lg bg-sky-50 p-3 text-xs text-sky-900 dark:bg-sky-900/30 dark:text-sky-200">
          Shopify shows <b>"This installation link can't be used"</b> if your app has <b>custom distribution</b> for a different store. A custom-distribution app installs on only one store, so for every other store use <b>Store's own app</b>.
        </p>
      )}
      {tab === "ownapp" && (
        <ol className="mt-3 list-decimal space-y-1 rounded-lg bg-gray-50 p-3 pl-7 text-xs text-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
          <li>
            In the Shopify Dev Dashboard (dev.shopify.com), click <b>Create app</b> (one app per store).
          </li>
          <li>
            Versions → App URL <b>{appUrl}</b>, Redirect URL <b>{redirectUrl}</b>, the same scopes as your main app → <b>Release</b>.
          </li>
          <li>
            Distribution → <b>Custom distribution</b> → enter this store's domain.
          </li>
          <li>
            Settings → copy the <b>Client ID</b> and <b>Client secret</b> into the boxes below, then click Continue and approve in Shopify.
          </li>
        </ol>
      )}
      {!oauth && tab === "manual" && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          The <b>Install app</b> option appears after you add <b>SHOPIFY_API_KEY</b> (Client ID) and <b>SHOPIFY_API_SECRET</b> (Client secret)
          from the Shopify Dev Dashboard to your hosting environment variables and redeploy. This tab only accepts an older custom-app token starting with <b>shpat_</b>.
        </div>
      )}
      <div className="mt-4 space-y-3">
        <Field label="Store domain" hint="e.g. glowcandles.myshopify.com">
          <Input value={f.shopDomain} onChange={(e) => setF({ ...f, shopDomain: e.target.value })} placeholder="yourstore.myshopify.com" />
        </Field>
        {tab === "ownapp" && (
          <>
            <Field label="Client ID">
              <Input value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} autoComplete="off" />
            </Field>
            <Field label="Client secret">
              <Input value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} type="password" autoComplete="off" />
            </Field>
          </>
        )}
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
        icon={Store}
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
                <div className="flex items-center gap-3">
                  <div className="brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-glow">{s.name.slice(0, 1).toUpperCase()}</div>
                  <div>
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-gray-500">{s.shopify_domain}</div>
                  </div>
                </div>
                <Badge tone={s.status === "active" ? "green" : "red"}>{s.status}</Badge>
              </div>
              <div className="mt-3 space-y-1 text-sm">
                <div className="flex items-center gap-1.5">
                  {s.display_number ? (
                    <>
                      <Smartphone className="h-4 w-4 text-brand-600" /> {s.display_number}
                    </>
                  ) : (
                    <span className="flex items-center gap-1.5 text-amber-600">
                      <AlertTriangle className="h-4 w-4" /> No WhatsApp number linked
                    </span>
                  )}
                </div>
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
      {can("admin") && (
        <Card title="Shopify app settings">
          <p className="mb-3 text-sm text-gray-500">
            In the Shopify Dev Dashboard → your app → <b>Versions</b>, paste these exactly, then click <b>Release</b>.
            {!me?.features?.shopifyOAuth && " Also add SHOPIFY_API_KEY (Client ID) and SHOPIFY_API_SECRET (Client secret) in your hosting settings and redeploy."}
          </p>
          <div className="space-y-3">
            {[
              ["App URL", me?.features?.shopifyAppUrl],
              ["Redirect URL", me?.features?.shopifyRedirectUrl],
              ...(me?.features?.shopifyOAuth ? [["Install link (share with store owners)", `${window.location.origin}/install`]] : []),
            ].map(([label, value]) => (
              <div key={label}>
                <div className="mb-1 text-xs font-medium text-gray-600 dark:text-gray-400">{label}</div>
                <div className="flex gap-2">
                  <Input readOnly value={value || ""} onFocus={(e) => e.target.select()} />
                  <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(value)}>
                    Copy
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {me?.features?.shopifyAppUrl && !me.features.shopifyAppUrl.startsWith(window.location.origin) && (
            <p className="mt-3 text-xs text-amber-700">
              These use {new URL(me.features.shopifyAppUrl).origin}, but you're browsing {window.location.origin}. Set APP_BASE_URL to the address you use, then redeploy.
            </p>
          )}
        </Card>
      )}
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
          appUrl={me?.features?.shopifyAppUrl}
          redirectUrl={me?.features?.shopifyRedirectUrl}
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
