import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi, post, patch, put, del } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { useStoreSettings } from "../lib/useStoreSettings.js";
import { dateTime } from "../lib/format.js";
import { Send, Smartphone, Unlink } from "lucide-react";
import { Card, Badge, Button, Empty, Field, Input, Select, Textarea, Toggle, Tabs, Table, Loading, ErrorBox, useAction } from "../components/ui.jsx";
import WhatsAppConnect, { ProviderBadge, unlinkQr } from "../components/WhatsAppConnect.jsx";

function CopyField({ label, value }) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Input readOnly value={value} onFocus={(e) => e.target.select()} />
        <Button variant="secondary" type="button" onClick={() => navigator.clipboard?.writeText(value)}>
          Copy
        </Button>
      </div>
    </Field>
  );
}

function WhatsAppTab({ data, reload }) {
  const [testPhone, setTestPhone] = useState("");
  const numbers = useApi("/whatsapp-numbers");
  const [run, busy] = useAction();
  const id = data.store.id;
  const wa = data.whatsapp;
  const gateway = wa?.provider === "gateway";
  const done = () => {
    reload();
    numbers.reload?.();
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
      <Card title="Linked number" icon={Smartphone}>
        {wa ? (
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-3">
              <div className="brand-gradient flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-glow">
                <Smartphone className="h-6 w-6" />
              </div>
              <div>
                <div className="text-lg font-bold tracking-tight">{wa.display_number || (gateway ? "Waiting for QR scan" : wa.phone_number_id)}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <ProviderBadge provider={wa.provider} status={wa.status} />
                  {!gateway && (
                    <Badge tone={wa.quality_rating === "GREEN" ? "green" : wa.quality_rating === "RED" ? "red" : "amber"}>Quality {wa.quality_rating || "unknown"}</Badge>
                  )}
                </div>
              </div>
            </div>
            {!gateway && (
              <>
                <div className="text-gray-500">
                  {wa.verified_name} · Limit {wa.messaging_limit || "—"}
                </div>
                <CopyField label="Webhook callback URL (Meta app → WhatsApp → Configuration)" value={wa.webhook_url} />
                <CopyField label="Verify token" value={wa.verify_token} />
                <p className="text-xs text-gray-500">Subscribe the webhook to the “messages”, “message_template_status_update” and “phone_number_quality_update” fields.</p>
              </>
            )}
            {gateway && (
              <p className="text-xs text-gray-500">
                Messages go out through your phone's WhatsApp, like WhatsApp Web. Buttons are sent as numbered options (customers reply 1, 2…). Keep the phone online now and then so the link stays active.
              </p>
            )}
            <div className="flex gap-2">
              <Input placeholder="Send a test message to…" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
              <Button variant="secondary" loading={busy} onClick={() => run(() => post(`/stores/${id}/whatsapp/test`, { phone: testPhone }), "Test message sent")}>
                <Send className="h-4 w-4" /> Test
              </Button>
            </div>
            <Button
              variant="ghost"
              onClick={() => confirm(gateway ? "Log this phone out and unlink it?" : "Unlink this number from the store?") && run(() => (gateway ? unlinkQr(id) : del(`/stores/${id}/whatsapp`)), "Unlinked").then(done)}
            >
              <Unlink className="h-4 w-4" /> {gateway ? "Log out & unlink" : "Unlink number"}
            </Button>
          </div>
        ) : (
          <Empty title="No WhatsApp number yet">Messages can't be sent until you connect one. Pick a method on the right.</Empty>
        )}
      </Card>
      <WhatsAppConnect storeId={id} numbers={numbers.data} run={run} busy={busy} onDone={done} hasNumber={!!wa && !(gateway && wa.status !== "active")} />
    </div>
  );
}

function AiTab({ id, data, s, reload }) {
  const [run, busy] = useAction();
  const [keys, setKeys] = useState({ openai: "", gemini: "", google: "" });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="AI assistant" actions={<Button size="sm" loading={busy} onClick={() => run(() => s.save(["ai"]), "Saved")}>Save</Button>}>
        <div className="space-y-4">
          <Toggle checked={s.get("ai.enabled")} onChange={(v) => s.set("ai.enabled", v)} label="Enable AI for this store" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Provider">
              <Select value={s.get("ai.provider")} onChange={(e) => s.set("ai.provider", e.target.value)} options={[{ value: "openai", label: "OpenAI (ChatGPT)" }, { value: "gemini", label: "Google Gemini" }]} />
            </Field>
            <Field label="Model (optional)" hint="Leave empty for the platform default">
              <Input value={s.get("ai.model")} onChange={(e) => s.set("ai.model", e.target.value)} />
            </Field>
          </div>
          <Toggle checked={s.get("ai.intent")} onChange={(v) => s.set("ai.intent", v)} label="Understand free-text replies (any language, Roman Urdu)" />
          <Toggle checked={s.get("ai.agent")} onChange={(v) => s.set("ai.agent", v)} label="AI agent answers customer questions" hint="Hands over to a human for complaints, refunds or when unsure." />
          <Toggle checked={s.get("ai.voiceNotes")} onChange={(v) => s.set("ai.voiceNotes", v)} label="Transcribe voice notes" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tone">
              <Input value={s.get("ai.tone")} onChange={(e) => s.set("ai.tone", e.target.value)} />
            </Field>
            <Field label="Reply language">
              <Input value={s.get("ai.replyLanguage")} onChange={(e) => s.set("ai.replyLanguage", e.target.value)} hint="auto = same as customer" />
            </Field>
            <Field label="Min confidence (0-1)">
              <Input type="number" step="0.05" min="0" max="1" value={s.get("ai.minConfidence")} onChange={(e) => s.set("ai.minConfidence", Number(e.target.value))} />
            </Field>
            <Field label="Pause AI after a human replies (hours)">
              <Input type="number" value={s.get("ai.humanPauseHours")} onChange={(e) => s.set("ai.humanPauseHours", Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Knowledge base" hint="Policies, delivery times, sizes, FAQs. The agent only answers from this and order data.">
            <Textarea className="min-h-[180px]" value={s.get("ai.knowledgeBase")} onChange={(e) => s.set("ai.knowledgeBase", e.target.value)} placeholder={"Delivery: 3-5 working days in Karachi, Lahore, Islamabad. 5-7 days elsewhere.\nReturns: within 7 days if unused.\nWorking hours: 10am-8pm Mon-Sat."} />
          </Field>
        </div>
      </Card>
      <Card title="API keys for this store">
        <p className="mb-3 text-sm text-gray-500">Optional. Without a store key the platform key is used (if configured). Keys are encrypted at rest.</p>
        {[
          ["openai", "OpenAI API key", "sk-…"],
          ["gemini", "Google Gemini API key", "AIza…"],
          ["google", "Google Maps API key (Address Validation, Geocoding, Static Maps)", "AIza…"],
        ].map(([p, label, ph]) => (
          <Field key={p} label={label} hint={data.apiKeys.includes(p) ? "✅ Store key saved" : data.platformKeys[p] ? "Using platform key" : "Not configured"} className="mb-3">
            <div className="flex gap-2">
              <Input type="password" placeholder={ph} value={keys[p]} onChange={(e) => setKeys({ ...keys, [p]: e.target.value })} />
              <Button variant="secondary" onClick={() => run(() => put(`/stores/${id}/api-keys`, { provider: p, key: keys[p] }), keys[p] ? "Key saved" : "Key removed").then(() => { setKeys({ ...keys, [p]: "" }); reload(); })}>
                {keys[p] ? "Save" : "Remove"}
              </Button>
            </div>
          </Field>
        ))}
      </Card>
    </div>
  );
}

function LogsTab({ id }) {
  const jobs = useApi(`/jobs?status=failed`);
  const [run] = useAction();
  const rows = (jobs.data || []).filter((j) => j.store_id === Number(id));
  return (
    <Card title="Failed background tasks" padded={false}>
      <Table
        rows={rows}
        empty="No failures 🎉"
        columns={[
          { key: "name", label: "Task" },
          { key: "last_error", label: "Error", render: (j) => <span className="text-xs text-red-600">{j.last_error}</span> },
          { key: "attempts", label: "Tries" },
          { key: "updated_at", label: "When", render: (j) => dateTime(j.updated_at) },
          { key: "order", label: "", render: (j) => j.order_id && <Link className="text-xs text-brand-700" to={`/orders/${j.order_id}`}>Order</Link> },
          { key: "retry", label: "", render: (j) => <Button size="sm" variant="secondary" onClick={() => run(() => post(`/jobs/${j.id}/retry`), "Retrying").then(jobs.reload)}>Retry</Button> },
        ]}
      />
    </Card>
  );
}

export default function StoreSettings() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, refresh } = useSession();
  const s = useStoreSettings(id);
  const [tab, setTab] = useState("general");
  const [run, busy] = useAction();
  const [general, setGeneral] = useState(null);
  if (s.error) return <ErrorBox error={s.error} />;
  if (!s.data || !s.draft) return <Loading />;
  const data = s.data;
  const st = data.store;
  const g = general || { name: st.name, currency: st.currency, timezone: st.timezone, country: st.country || "", logo_url: st.logo_url || "", status: st.status };
  const tags = s.get("tags");

  return (
    <div className="space-y-4">
      <div>
        <Link to="/stores" className="text-sm text-gray-500 hover:underline">
          ← Stores
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
          {st.name} <Badge tone={st.status === "active" ? "green" : "red"}>{st.status}</Badge>
        </h1>
        <div className="text-sm text-gray-500">
          {st.shopify_domain} · {st.connection_type === "oauth" ? "Installed app" : "Custom app token"} · webhooks {st.webhooks_registered_at ? `registered ${dateTime(st.webhooks_registered_at)}` : "not registered"}
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "general", label: "General" },
          { value: "whatsapp", label: "WhatsApp" },
          { value: "ai", label: "AI & keys" },
          { value: "tags", label: "Shopify tags" },
          { value: "bundles", label: "Bundles" },
          { value: "logs", label: "Logs", count: Number(data.failedJobs) || undefined },
        ]}
      />

      {tab === "general" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Store details" actions={can("admin") && <Button size="sm" loading={busy} onClick={() => run(() => patch(`/stores/${id}`, g), "Saved").then(() => { s.reload(); refresh(); })}>Save</Button>}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name shown in messages">
                <Input value={g.name} onChange={(e) => setGeneral({ ...g, name: e.target.value })} />
              </Field>
              <Field label="Status">
                <Select value={g.status} onChange={(e) => setGeneral({ ...g, status: e.target.value })} options={[{ value: "active", label: "Active" }, { value: "paused", label: "Paused (no messages)" }]} />
              </Field>
              <Field label="Currency">
                <Input value={g.currency} onChange={(e) => setGeneral({ ...g, currency: e.target.value })} maxLength={3} />
              </Field>
              <Field label="Timezone">
                <Input value={g.timezone} onChange={(e) => setGeneral({ ...g, timezone: e.target.value })} placeholder="Asia/Karachi" />
              </Field>
              <Field label="Country (phone numbers)">
                <Input value={g.country} onChange={(e) => setGeneral({ ...g, country: e.target.value })} maxLength={2} placeholder="PK" />
              </Field>
              <Field label="Logo URL (fallback image)">
                <Input value={g.logo_url} onChange={(e) => setGeneral({ ...g, logo_url: e.target.value })} />
              </Field>
            </div>
          </Card>
          <Card title="Messages & language" actions={<Button size="sm" loading={busy} onClick={() => run(() => s.save(["language", "defaultProductImage", "displayName"]), "Saved")}>Save</Button>}>
            <div className="space-y-3">
              <Field label="Template language code" hint="Templates in this language are preferred (en, ur, ar…)">
                <Input value={s.get("language")} onChange={(e) => s.set("language", e.target.value)} />
              </Field>
              <Field label="Default product image" hint="Used in message headers when a product has no image">
                <Input value={s.get("defaultProductImage")} onChange={(e) => s.set("defaultProductImage", e.target.value)} />
              </Field>
            </div>
          </Card>
          <Card title="Connection">
            <div className="space-y-3 text-sm">
              <CopyField label="Shopify webhook URL" value={data.webhookUrl} />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" loading={busy} onClick={() => run(() => post(`/stores/${id}/setup`), "Re-registering webhooks and templates")}>
                  Re-register webhooks
                </Button>
                <Button variant="secondary" loading={busy} onClick={() => run(() => post(`/stores/${id}/backfill`, { days: 60 }), "Importing the last 60 days of orders")}>
                  Import past orders
                </Button>
              </div>
              {can("owner") && (
                <Button variant="danger" onClick={() => confirm(`Delete ${st.name} and all its data? This can't be undone.`) && run(() => del(`/stores/${id}`), "Store deleted").then(async () => { await refresh(); navigate("/stores"); })}>
                  Delete store
                </Button>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === "whatsapp" && <WhatsAppTab data={data} reload={s.reload} />}
      {tab === "ai" && <AiTab id={id} data={data} s={s} reload={s.reload} />}

      {tab === "tags" && (
        <Card title="Tags added to Shopify orders" actions={<Button size="sm" loading={busy} onClick={() => run(() => s.save(["tags"]), "Saved")}>Save</Button>}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.keys(tags).map((k) => (
              <Field key={k} label={k.replace(/([A-Z])/g, " $1").toLowerCase()}>
                <Input value={tags[k]} onChange={(e) => s.set(`tags.${k}`, e.target.value)} placeholder="(empty = don't tag)" />
              </Field>
            ))}
          </div>
        </Card>
      )}

      {tab === "bundles" && (
        <Card title="Bundle splitter" actions={<Button size="sm" loading={busy} onClick={() => run(() => s.save(["bundles"]), "Saved")}>Save</Button>}>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">Adds component SKUs to orders that contain a bundle SKU (e.g. for fulfilment apps like AutoDS), using Shopify order editing.</p>
            <Toggle checked={s.get("bundles.enabled")} onChange={(v) => s.set("bundles.enabled", v)} label="Split bundles on new orders" />
            <Toggle checked={s.get("bundles.removeBundleLine")} onChange={(v) => s.set("bundles.removeBundleLine", v)} label="Remove the bundle line after adding components" />
            <Field label="Rules (JSON)" hint='[{"bundleSku":"BUNDLE-1","components":[{"sku":"CANDLE","quantity":1},{"sku":"BATTERY","quantity":2}]}]'>
              <Textarea
                className="min-h-[160px] font-mono text-xs"
                defaultValue={JSON.stringify(s.get("bundles.rules"), null, 2)}
                onBlur={(e) => {
                  try {
                    s.set("bundles.rules", JSON.parse(e.target.value || "[]"));
                  } catch {
                    alert("Invalid JSON");
                  }
                }}
              />
            </Field>
          </div>
        </Card>
      )}

      {tab === "logs" && <LogsTab id={id} />}
    </div>
  );
}
