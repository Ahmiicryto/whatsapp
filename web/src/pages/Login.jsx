import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { Button, Field, Input, ErrorBox } from "../components/ui.jsx";

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
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-50 to-white p-4 dark:from-gray-950 dark:to-gray-900">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-2xl text-white">✓</div>
          <h1 className="text-xl font-semibold">WA Commerce</h1>
          <p className="text-sm text-gray-500">
            {claiming ? "Sign in or create an account to finish linking your Shopify store" : "WhatsApp automation for your Shopify stores"}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {mode === "signup" && (
            <>
              <Field label="Your name">
                <Input value={form.name} onChange={set("name")} required />
              </Field>
              <Field label="Business name">
                <Input value={form.accountName} onChange={set("accountName")} required placeholder="e.g. Glow Group" />
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
          <Button className="w-full" loading={busy} type="submit">
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
          <p className="text-center text-xs text-gray-500">
            {mode === "login" ? "New here? " : "Already have an account? "}
            <button type="button" className="font-medium text-brand-700" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
