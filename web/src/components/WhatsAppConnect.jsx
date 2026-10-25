import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Facebook, KeyRound, QrCode, ShieldCheck, Smartphone } from "lucide-react";
import { post, get, del } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { Badge, Button, Card, ErrorBox, Field, Input, Select, Skeleton, Toggle, cx, useToast } from "./ui.jsx";

// ---------------------------------------------------------------- Facebook SDK (Meta Embedded Signup)

let sdkPromise;
function loadFacebookSdk(appId, version) {
  if (window.FB) return Promise.resolve(window.FB);
  sdkPromise ||= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdkPromise = null;
      reject(new Error("Could not load Facebook login. Check your ad blocker and try again."));
    };
    document.body.appendChild(s);
  });
  return sdkPromise;
}

function FacebookConnect({ storeId, onDone }) {
  const { me } = useSession();
  const f = me?.features || {};
  const toast = useToast();
  const [coexistence, setCoexistence] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const session = useRef(null);

  // Meta posts the chosen phone number / WABA ids to the window while the popup is open.
  useEffect(() => {
    const onMessage = (e) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(e.origin).hostname)) return;
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (data.event?.startsWith("FINISH")) session.current = data.data;
        if (data.event === "CANCEL") session.current = null;
      } catch {
        /* other facebook.com messages */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!f.metaAppId || !f.metaSignupConfigId) {
    return (
      <SetupNote>
        Add <b>META_APP_ID</b>, <b>META_APP_SECRET</b> and <b>META_EMBEDDED_SIGNUP_CONFIG_ID</b> (Meta app → WhatsApp → Embedded Signup → Configuration ID) to your hosting settings and redeploy. Your Meta app must be a Tech Provider.
      </SetupNote>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    session.current = null;
    try {
      const FB = await loadFacebookSdk(f.metaAppId, f.metaGraphVersion || "v21.0");
      const code = await new Promise((resolve, reject) =>
        FB.login(
          (resp) => (resp.authResponse?.code ? resolve(resp.authResponse.code) : reject(new Error("Facebook login was cancelled."))),
          {
            config_id: f.metaSignupConfigId,
            response_type: "code",
            override_default_response_type: true,
            extras: { setup: {}, sessionInfoVersion: "3", ...(coexistence ? { featureType: "whatsapp_business_app_onboarding" } : {}) },
          }
        )
      );
      // the session-info message can arrive just after the login callback
      for (let i = 0; i < 20 && !session.current; i++) await new Promise((r) => setTimeout(r, 150));
      const info = session.current;
      if (!info?.phone_number_id || !info?.waba_id) throw new Error("Meta didn't return a phone number. Finish every step in the popup, then try again.");
      await post(`/stores/${storeId}/whatsapp/embedded`, { code, phoneNumberId: info.phone_number_id, wabaId: info.waba_id, coexistence });
      toast("WhatsApp connected. Default templates are being submitted to Meta.");
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
        <Step n="1">Click the button and sign in with the Facebook account that manages your business.</Step>
        <Step n="2">Pick or create your WhatsApp Business account and phone number.</Step>
        <Step n="3">{coexistence ? "Scan the QR code Meta shows with the WhatsApp Business app on your phone." : "Verify the number with the code Meta sends."}</Step>
      </ol>
      <Toggle
        checked={coexistence}
        onChange={setCoexistence}
        label="Keep using the WhatsApp Business app on my phone"
        hint="Meta's official QR 'coexistence' onboarding: chats stay on your phone and the API works at the same time."
      />
      <ErrorBox error={error} />
      <Button size="lg" loading={busy} onClick={start} className="w-full !bg-none !bg-[#1877f2] !shadow-none hover:!brightness-110">
        <Facebook className="h-4 w-4" /> Continue with Facebook
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- WhatsApp Web-style QR (gateway)

function QrConnect({ storeId, onDone }) {
  const { me } = useSession();
  const toast = useToast();
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const polling = state && ["qr", "connecting"].includes(state.status);
  useEffect(() => {
    if (!polling) return undefined;
    const t = setInterval(async () => {
      try {
        const s = await get(`/stores/${storeId}/whatsapp/qr`);
        setState(s);
        if (s.status === "connected") {
          toast(`WhatsApp connected${s.phone ? `: ${s.phone}` : ""}`);
          onDone();
        }
      } catch (e) {
        setError(e);
      }
    }, 2500);
    return () => clearInterval(t);
  }, [polling, storeId]);

  if (!me?.features?.qrGateway) {
    return (
      <SetupNote>
        QR login needs the small always-on <b>WhatsApp gateway</b> service (folder <code>gateway/</code>, deploy it on Render). Then add <b>GATEWAY_URL</b> and <b>GATEWAY_SECRET</b> to your hosting settings and redeploy.
      </SetupNote>
    );
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setState(await post(`/stores/${storeId}/whatsapp/qr`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <b>Unofficial connection.</b> It works like WhatsApp Web on your own number, with no Meta approval and no template fees, but WhatsApp may ban numbers that send bulk or unwanted messages. Use it for order updates to your own customers; prefer the official option for marketing.
        </div>
      </div>
      {!state || ["logged_out", "not_started", "none", "error"].includes(state.status) ? (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 accent-brand-600" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            I understand the risk and will only message customers who ordered from me.
          </label>
          {state?.status === "logged_out" && <p className="text-sm text-red-600">The phone was logged out. Generate a new QR code.</p>}
          {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
          <ErrorBox error={error} />
          <Button size="lg" className="w-full" disabled={!accepted} loading={busy} onClick={start}>
            <QrCode className="h-4 w-4" /> Generate QR code
          </Button>
        </>
      ) : state.status === "connected" ? (
        <div className="flex items-center gap-3 rounded-xl bg-brand-50 p-4 text-sm text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">
          <CheckCircle2 className="h-5 w-5" /> Connected {state.phone}
        </div>
      ) : (
        <div className="grid items-center gap-5 sm:grid-cols-[auto_1fr]">
          <div className="relative mx-auto rounded-3xl bg-white p-3 shadow-lift ring-1 ring-gray-200">
            {state.qr ? <img src={state.qr} alt="WhatsApp QR code" className="h-56 w-56" /> : <Skeleton className="h-56 w-56" />}
            <span className="brand-gradient absolute -bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] font-semibold text-white shadow-glow">
              {state.status === "qr" ? "Waiting for scan…" : "Connecting…"}
            </span>
          </div>
          <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
            <Step n="1">Open WhatsApp on the phone with your business number.</Step>
            <Step n="2">
              Tap <b>⋮ Menu</b> or <b>Settings</b> → <b>Linked devices</b>.
            </Step>
            <Step n="3">
              Tap <b>Link a device</b> and point the phone at this code.
            </Step>
            <li className="pt-1 text-xs text-gray-400">The code refreshes automatically. Keep this page open.</li>
          </ol>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- manual Cloud API credentials

function ManualConnect({ storeId, onDone, numbers, run, busy }) {
  const [f, setF] = useState({ phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "" });
  const [existing, setExisting] = useState("");
  return (
    <div className="space-y-3">
      {numbers?.length > 0 && (
        <Field label="Use a number already in this account" hint="Several stores can share one number.">
          <div className="flex gap-2">
            <Select value={existing} onChange={(e) => setExisting(e.target.value)}>
              <option value="">Choose…</option>
              {numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.display_number || n.phone_number_id} ({(n.stores || []).join(", ") || "unused"})
                </option>
              ))}
            </Select>
            <Button variant="secondary" disabled={!existing} onClick={() => run(() => post(`/stores/${storeId}/whatsapp`, { numberId: Number(existing) }), "Number linked").then(onDone)}>
              Use
            </Button>
          </div>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone number ID">
          <Input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} />
        </Field>
        <Field label="WhatsApp Business Account ID">
          <Input value={f.wabaId} onChange={(e) => setF({ ...f, wabaId: e.target.value })} />
        </Field>
      </div>
      <Field label="Permanent access token" hint="System user token with whatsapp_business_messaging and whatsapp_business_management.">
        <Input type="password" value={f.accessToken} onChange={(e) => setF({ ...f, accessToken: e.target.value })} />
      </Field>
      <Field label="App secret (only if this number belongs to your own Meta app)" hint="Leave empty to use the platform's Meta app.">
        <Input type="password" value={f.appSecret} onChange={(e) => setF({ ...f, appSecret: e.target.value })} />
      </Field>
      <Button loading={busy} onClick={() => run(() => post(`/stores/${storeId}/whatsapp`, f), "Number linked. Default templates are being submitted to Meta.").then(onDone)}>
        Link number
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function Step({ n, children }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700 dark:bg-brand-900/50 dark:text-brand-300">{n}</span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

function SetupNote({ children }) {
  return <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4 text-sm leading-relaxed text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">{children}</div>;
}

const METHODS = [
  { value: "facebook", label: "Connect with Facebook", sub: "Official Cloud API · recommended", icon: ShieldCheck },
  { value: "qr", label: "Scan QR code", sub: "WhatsApp Web style · unofficial", icon: Smartphone },
  { value: "manual", label: "Enter API details", sub: "Phone number ID + token", icon: KeyRound },
];

export default function WhatsAppConnect({ storeId, numbers, run, busy, onDone, hasNumber }) {
  const [method, setMethod] = useState("facebook");
  return (
    <Card title={hasNumber ? "Connect a different number" : "Connect WhatsApp"} icon={QrCode}>
      <div className="mb-5 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Connection method">
        {METHODS.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={method === m.value}
            onClick={() => setMethod(m.value)}
            className={cx(
              "flex items-start gap-3 rounded-xl p-3 text-left ring-1 transition",
              method === m.value ? "bg-brand-50 ring-2 ring-brand-500 dark:bg-brand-900/20" : "ring-gray-200 hover:bg-gray-50 hover:ring-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800/50"
            )}
          >
            <m.icon className={cx("mt-0.5 h-5 w-5 shrink-0", method === m.value ? "text-brand-600" : "text-gray-400")} />
            <span>
              <span className="block text-sm font-semibold">{m.label}</span>
              <span className="block text-xs text-gray-500">{m.sub}</span>
            </span>
          </button>
        ))}
      </div>
      {method === "facebook" && <FacebookConnect storeId={storeId} onDone={onDone} />}
      {method === "qr" && <QrConnect storeId={storeId} onDone={onDone} />}
      {method === "manual" && <ManualConnect storeId={storeId} onDone={onDone} numbers={numbers} run={run} busy={busy} />}
    </Card>
  );
}

/** Small status pill for the linked number card. */
export function ProviderBadge({ provider, status }) {
  if (provider === "gateway")
    return (
      <Badge tone={status === "active" ? "green" : "amber"} dot>
        QR linked · {status === "active" ? "online" : status}
      </Badge>
    );
  return (
    <Badge tone="blue" dot>
      Official Cloud API
    </Badge>
  );
}

export const unlinkQr = (storeId) => del(`/stores/${storeId}/whatsapp/qr`);
