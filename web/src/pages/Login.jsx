import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Button, Field, Input, ErrorBox } from "../components/ui.jsx";
import { Logo } from "../components/Layout.jsx";

export default function Login() {
  const { me, refresh } = useSession();
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "", accountName: "" });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = (params.get("next") || "/").startsWith("/") && !(params.get("next") || "").startsWith("//") ? params.get("next") || "/" : "/";
  const claiming = next.startsWith("/claim-store");
  if (me) return <Navigate to={next} replace />;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(mode === "login" ? "/auth/login" : "/auth/signup", form);
      await refresh();
      navigate(next);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-navy-950 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: "radial-gradient(40rem 26rem at 10% 0%, rgb(37 211 102 / 0.28), transparent 60%), radial-gradient(30rem 24rem at 100% 100%, rgb(5 150 105 / 0.3), transparent 60%)" }}
        />
        <div className="relative flex items-center gap-3">
          <Logo className="h-10 w-10" />
          <span className="text-lg font-bold tracking-tight">WA Commerce</span>
        </div>
        <div className="relative">
          <HeroArt />
          <h2 className="mt-8 max-w-md text-3xl font-bold leading-tight tracking-tight">
            Every Shopify order, <span className="text-gradient">confirmed on WhatsApp.</span>
          </h2>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-300">
            Automatic order confirmations with product photos, address checks, tracking updates, AI replies, campaigns and daily owner reports — for every store you run.
          </p>
        </div>
        <div className="relative flex gap-6 text-xs text-slate-400">
          {["Order sync", "QR or Cloud API", "AI replies", "Daily reports"].map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-brand-400" />
              {t}
            </span>
          ))}
        </div>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="animate-rise w-full max-w-sm">
          <div className="mb-8">
            <Logo className="mb-5 h-11 w-11 lg:hidden" />
            <h1 className="text-2xl font-bold tracking-tight">{mode === "login" ? "Welcome back" : "Create your account"}</h1>
            <p className="mt-1 text-sm text-gray-500">
              {claiming ? "Sign in or create an account to finish linking your Shopify store." : "WhatsApp automation for your Shopify stores."}
            </p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <>
                <Field label="Your name">
                  <Input value={form.name} onChange={set("name")} required autoComplete="name" />
                </Field>
                <Field label="Business name">
                  <Input value={form.accountName} onChange={set("accountName")} required placeholder="e.g. Glow Group" autoComplete="organization" />
                </Field>
              </>
            )}
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set("email")} required autoComplete="email" />
            </Field>
            <Field label="Password">
              <Input type="password" value={form.password} onChange={set("password")} required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            </Field>
            <ErrorBox error={error} />
            <Button className="w-full" size="lg" loading={busy} type="submit">
              {mode === "login" ? "Sign in" : "Create account"}
              <ArrowRight className="h-4 w-4" />
            </Button>
            <p className="text-center text-sm text-gray-500">
              {mode === "login" ? "New here? " : "Already have an account? "}
              <button type="button" className="font-semibold text-brand-700 hover:underline dark:text-brand-400" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
          </form>
        </div>
      </section>
    </div>
  );
}

/** Phone mock-up: an order confirmation with product photo and reply buttons. */
function HeroArt() {
  return (
    <svg viewBox="0 0 420 260" className="w-full max-w-md drop-shadow-2xl" role="img" aria-label="WhatsApp order confirmation preview">
      <defs>
        <linearGradient id="h-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#25d366" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
        <linearGradient id="h-p" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fde68a" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="260" height="260" rx="28" fill="#0f2236" stroke="rgb(255 255 255 / 0.1)" />
      <rect x="12" y="12" width="236" height="40" rx="14" fill="url(#h-g)" />
      <circle cx="34" cy="32" r="10" fill="white" opacity="0.9" />
      <rect x="52" y="24" width="70" height="7" rx="3.5" fill="white" />
      <rect x="52" y="35" width="44" height="5" rx="2.5" fill="white" opacity="0.7" />
      <rect x="22" y="64" width="190" height="150" rx="14" fill="#1b3149" />
      <rect x="30" y="72" width="174" height="74" rx="10" fill="url(#h-p)" />
      <rect x="92" y="88" width="50" height="42" rx="8" fill="white" opacity="0.85" />
      <rect x="104" y="80" width="26" height="12" rx="6" fill="none" stroke="white" strokeWidth="3" opacity="0.85" />
      <rect x="30" y="154" width="120" height="7" rx="3.5" fill="#e2e8f0" />
      <rect x="30" y="167" width="150" height="6" rx="3" fill="#94a3b8" />
      <rect x="30" y="178" width="96" height="6" rx="3" fill="#94a3b8" />
      <rect x="30" y="192" width="54" height="14" rx="7" fill="#25d366" opacity="0.25" />
      <rect x="22" y="220" width="92" height="26" rx="10" fill="#1b3149" stroke="#25d366" strokeOpacity="0.5" />
      <text x="68" y="237" textAnchor="middle" fontSize="10" fontWeight="700" fill="#34d399">✓ Confirm</text>
      <rect x="120" y="220" width="92" height="26" rx="10" fill="#1b3149" stroke="rgb(255 255 255 / 0.15)" />
      <text x="166" y="237" textAnchor="middle" fontSize="10" fontWeight="600" fill="#cbd5e1">Change address</text>
      <g transform="translate(270 40)">
        <rect width="150" height="78" rx="16" fill="white" />
        <text x="16" y="26" fontSize="10" fontWeight="600" fill="#64748b">Confirmed today</text>
        <text x="16" y="52" fontSize="24" fontWeight="800" fill="#0f172a">92%</text>
        <polyline points="86,58 100,48 112,52 124,36 136,40" fill="none" stroke="#059669" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g transform="translate(270 132)">
        <rect width="150" height="58" rx="16" fill="white" opacity="0.95" />
        <circle cx="26" cy="29" r="12" fill="url(#h-g)" />
        <path d="M20 29l4 4 8-8" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <rect x="46" y="20" width="84" height="7" rx="3.5" fill="#0f172a" />
        <rect x="46" y="32" width="60" height="6" rx="3" fill="#94a3b8" />
      </g>
    </svg>
  );
}
