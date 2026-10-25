import { useEffect, useState } from "react";
import { BellRing, FileBarChart2, KeyRound, Smartphone, UserCircle2 } from "lucide-react";
import { useApi, put, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Toggle, useAction } from "../components/ui.jsx";

export default function Profile() {
  const { me, stores, refresh } = useSession();
  const { data, error, reload } = useApi("/profile");
  const [f, setF] = useState(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [run, busy] = useAction();
  useEffect(() => {
    if (data) setF({ name: data.name || "", phone: data.phone_e164 || "", dailyReport: data.dailyReport, alerts: data.alerts });
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!f) return <Loading />;

  return (
    <div className="space-y-5">
      <PageHeader icon={UserCircle2} title="My profile" subtitle={me?.user?.email} />
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card title="Daily report on WhatsApp" icon={FileBarChart2}>
          <div className="space-y-4">
            <div className="flex items-start gap-4 rounded-2xl bg-gradient-to-br from-brand-50 to-white p-4 ring-1 ring-brand-100 dark:from-brand-900/20 dark:to-transparent dark:ring-brand-900/40">
              <div className="brand-gradient flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-glow">
                <Smartphone className="h-5 w-5" />
              </div>
              <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                Every evening you get one WhatsApp message with a PDF covering <b>all {stores.length} of your stores</b>: orders, revenue, confirmations, cancellations, messages and AI replies, compared with the day before.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Your name">
                <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
              </Field>
              <Field label="Your WhatsApp number" hint="With country code, e.g. +92 300 1234567">
                <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} type="tel" autoComplete="tel" placeholder="+92…" />
              </Field>
            </div>
            <Toggle checked={f.dailyReport} onChange={(v) => setF({ ...f, dailyReport: v })} label="Send me the daily report" hint="Sent at each store's report time from that store's WhatsApp number." />
            <Toggle checked={f.alerts} onChange={(v) => setF({ ...f, alerts: v })} label="Send me urgent alerts" hint="WhatsApp disconnected, Shopify app removed, or a store keeps failing." />
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={() => run(() => put("/profile", f), "Profile saved").then(() => (reload(), refresh()))}>
                Save
              </Button>
              {data.dailyReport && data.phone_e164 && (
                <Button variant="secondary" loading={busy} onClick={() => run(() => post("/profile/test-report"), "Report sent to your WhatsApp")}>
                  <BellRing className="h-4 w-4" /> Send me a sample now
                </Button>
              )}
            </div>
          </div>
        </Card>
        <Card title="Password" icon={KeyRound}>
          <div className="space-y-3">
            <Field label="Current password">
              <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="At least 8 characters. Other devices are signed out.">
              <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" minLength={8} />
            </Field>
            <Button variant="secondary" disabled={!pw.current || pw.next.length < 8} loading={busy} onClick={() => run(() => post("/auth/change-password", pw), "Password changed").then(() => setPw({ current: "", next: "" }))}>
              Change password
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
