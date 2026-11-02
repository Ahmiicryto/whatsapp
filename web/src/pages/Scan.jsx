import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, PackageCheck, PackageSearch, RotateCcw, ScanLine, Truck, XCircle } from "lucide-react";
import { useApi, post, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago, money, SHIP_LABEL, SHIP_TONE } from "../lib/format.js";
import { Badge, Card, Input, PageHeader, cx } from "../components/ui.jsx";
import BarcodeScanner from "../components/BarcodeScanner.jsx";

const MODES = [
  { value: "return_received", label: "Return received", icon: RotateCcw, hint: "Scan parcels coming back to you" },
  { value: "delivered", label: "Delivered", icon: PackageCheck, hint: "Mark parcels as delivered" },
  { value: "dispatched", label: "Handed to courier", icon: Truck, hint: "Scan parcels as the rider picks them up" },
  { value: "lookup", label: "Look up", icon: PackageSearch, hint: "Just show the order" },
];

const RESULT_STYLE = {
  ok: { cls: "bg-brand-600 text-white", icon: CheckCircle2 },
  already: { cls: "bg-amber-500 text-white", icon: AlertTriangle },
  not_found: { cls: "bg-red-600 text-white", icon: XCircle },
  error: { cls: "bg-red-600 text-white", icon: XCircle },
};

let audio;
/** Short confirmation tone + vibration so the scanner can be used without looking at the screen. */
function feedback(ok) {
  try {
    navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
    audio ||= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.12, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (ok ? 0.12 : 0.35));
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  } catch {
    /* no audio */
  }
}

export default function Scan() {
  const { storeId } = useSession();
  const [mode, setMode] = useState(() => {
    try {
      return localStorage.getItem("wa.scanMode") || "return_received";
    } catch {
      return "return_received";
    }
  });
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [session, setSession] = useState(0);
  const recent = useApi(`/scan/recent${qs({ storeId })}`);
  const input = useRef(null);

  useEffect(() => {
    try {
      localStorage.setItem("wa.scanMode", mode);
    } catch {
      /* private mode */
    }
  }, [mode]);

  async function submit(code) {
    if (!code || busy) return;
    setBusy(true);
    try {
      const r = await post("/scan", { code, action: mode });
      setResult(r);
      feedback(r.result === "ok");
      if (r.result === "ok" && mode !== "lookup") setSession((n) => n + 1);
      recent.reload();
    } catch (e) {
      setResult({ result: "error", message: e.message });
      feedback(false);
    } finally {
      setBusy(false);
      setManual("");
      input.current?.focus();
    }
  }

  const s = recent.data?.summary;
  const rs = result && (RESULT_STYLE[result.result] || RESULT_STYLE.error);
  const current = MODES.find((m) => m.value === mode);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader icon={ScanLine} title="Scan parcels" subtitle={current.hint} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="What are you scanning for?">
        {MODES.map((m) => (
          <button
            key={m.value}
            role="radio"
            aria-checked={mode === m.value}
            onClick={() => setMode(m.value)}
            className={cx(
              "flex items-center justify-center gap-2 rounded-2xl px-3 py-3 text-sm font-semibold ring-1 transition",
              mode === m.value ? "brand-gradient text-white shadow-glow ring-transparent" : "bg-white ring-gray-200 hover:ring-gray-300 dark:bg-gray-900 dark:ring-gray-700"
            )}
          >
            <m.icon className="h-4 w-4" /> {m.label}
          </button>
        ))}
      </div>

      <BarcodeScanner onCode={submit} paused={busy} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(manual.trim());
        }}
      >
        <Input
          ref={input}
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="…or type / use a USB scanner: tracking number or order #"
          aria-label="Tracking or order number"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </form>

      {result && (
        <div className="animate-rise overflow-hidden rounded-2xl bg-white shadow-lift dark:bg-gray-900" aria-live="assertive">
          <div className={cx("flex items-center gap-3 px-4 py-3 text-base font-bold", rs.cls)}>
            <rs.icon className="h-6 w-6 shrink-0" />
            {result.message}
          </div>
          {result.order && (
            <div className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Link to={`/orders/${result.order.id}`} className="text-lg font-bold text-brand-700 hover:underline dark:text-brand-400">
                    {result.order.name}
                  </Link>
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    {result.order.customer_name} · {result.order.city} · {result.order.phone}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-bold">{money(result.order.total, result.order.currency)}</div>
                  <div className="text-xs text-gray-500">{result.order.is_cod ? "Cash on delivery" : "Prepaid"}</div>
                </div>
              </div>
              {result.shipment && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={SHIP_TONE[result.shipment.status]} dot>
                    {SHIP_LABEL[result.shipment.status]}
                  </Badge>
                  <span className="text-gray-500">
                    {result.shipment.courier} · <span className="font-mono">{result.shipment.tracking_number}</span>
                  </span>
                  {result.shipment.return_received_at && <Badge tone="purple">Return received {ago(result.shipment.return_received_at)}</Badge>}
                </div>
              )}
              <div className="flex gap-2 overflow-x-auto">
                {result.items.map((i, k) => (
                  <div key={k} className="w-24 shrink-0 text-xs">
                    {i.image_url ? <img src={i.image_url} alt="" className="aspect-square w-24 rounded-xl object-cover" /> : <div className="aspect-square w-24 rounded-xl bg-gray-100 dark:bg-gray-800" />}
                    <div className="mt-1 line-clamp-2 font-medium">
                      {i.quantity}× {i.title}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        {[
          ["This session", session],
          ["Returns today", s?.returns_today ?? 0],
          ["Delivered today", s?.delivered_today ?? 0],
          ["Handed over today", s?.dispatched_today ?? 0],
        ].map(([label, v]) => (
          <div key={label} className="rounded-2xl bg-white p-3 shadow-soft dark:bg-gray-900">
            <div className="text-2xl font-bold tabular-nums">{v}</div>
            <div className="text-[11px] text-gray-500">{label}</div>
          </div>
        ))}
      </div>

      <Card title="Recent scans" padded={false}>
        <ul className="divide-y divide-gray-50 dark:divide-gray-800">
          {(recent.data?.rows || []).length === 0 && <li className="p-4 text-sm text-gray-500">No scans yet</li>}
          {(recent.data?.rows || []).map((r) => {
            const st = RESULT_STYLE[r.result] || RESULT_STYLE.error;
            return (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <st.icon className={cx("h-4 w-4 shrink-0", r.result === "ok" ? "text-brand-600" : r.result === "already" ? "text-amber-500" : "text-red-600")} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {r.order_name || r.code} <span className="font-normal text-gray-500">· {MODES.find((m) => m.value === r.action)?.label}</span>
                  </div>
                  <div className="truncate text-xs text-gray-500">
                    {r.tracking_number || r.code} · {r.user_name || ""} · {ago(r.created_at)}
                  </div>
                </div>
                {r.shipment_status && <Badge tone={SHIP_TONE[r.shipment_status]}>{SHIP_LABEL[r.shipment_status]}</Badge>}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
