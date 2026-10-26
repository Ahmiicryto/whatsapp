import { CheckCircle2, CreditCard, Landmark, Sparkles } from "lucide-react";
import { useApi, post } from "../lib/api.js";
import { date, num } from "../lib/format.js";
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, cx, useAction } from "../components/ui.jsx";

function Meter({ label, used, max }) {
  const unlimited = max === undefined || max === null;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="font-semibold tabular-nums">
          {num(used)} {unlimited ? "" : `/ ${num(max)}`}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cx("h-full rounded-full", pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "brand-gradient")} style={{ width: unlimited ? "4%" : `${pct}%` }} />
      </div>
    </div>
  );
}

export default function Billing() {
  const { data, error } = useApi("/billing");
  const [run, busy] = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.enabled) {
    return (
      <div className="space-y-5">
        <PageHeader icon={CreditCard} title="Billing & plan" />
        <Card>
          <Empty title="No billing on this installation">Everything is unlimited. The super admin can turn on plans under Super admin → Plans.</Empty>
        </Card>
      </div>
    );
  }
  const a = data.account;
  const l = data.limits;
  const u = data.usage;
  const checkout = (planId) => run(() => post("/billing/checkout", { planId })).then((r) => r?.url && (window.location.href = r.url));
  return (
    <div className="space-y-5">
      <PageHeader icon={CreditCard} title="Billing & plan" subtitle="Your plan, this month's usage and upgrades" />
      {!data.active && <ErrorBox error={{ message: `${data.reason} Messages are paused until then.` }} />}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <Card title="Current plan" icon={Sparkles}>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold capitalize tracking-tight">{data.plans.find((p) => p.id === a.plan)?.name || a.plan}</span>
              <Badge tone={a.status === "active" ? "green" : a.status === "trialing" ? "blue" : "red"} dot>
                {a.status}
              </Badge>
            </div>
            <div className="text-sm text-gray-500">
              {a.status === "trialing" && a.trialEndsAt && `Free trial until ${date(a.trialEndsAt)}`}
              {a.status !== "trialing" && a.paidUntil && `Paid until ${date(a.paidUntil)}`}
            </div>
            <Meter label="WhatsApp messages this month" used={u.messages} max={l.messages} />
            <Meter label="AI replies this month" used={u.aiReplies} max={l.aiReplies} />
            <Meter label="Stores" used={u.stores} max={l.stores} />
            <Meter label="Team members" used={u.users} max={l.users} />
            {a.hasStripe && (
              <Button variant="secondary" loading={busy} onClick={() => run(() => post("/billing/portal")).then((r) => r?.url && (window.location.href = r.url))}>
                Manage card & invoices
              </Button>
            )}
          </div>
        </Card>
        <Card title="Pay by bank or wallet" icon={Landmark}>
          {data.bankInstructions ? (
            <>
              <p className="whitespace-pre-wrap text-sm">{data.bankInstructions}</p>
              <p className="mt-3 text-xs text-gray-500">After paying, send the receipt{data.contact ? ` to ${data.contact}` : ""}. Your plan is activated by the admin, usually the same day.</p>
            </>
          ) : (
            <p className="text-sm text-gray-500">Card payments only.</p>
          )}
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {data.plans
          .filter((p) => p.id !== "trial")
          .map((p) => {
            const current = p.id === a.plan;
            return (
              <div key={p.id} className={cx("animate-rise relative flex flex-col rounded-2xl bg-white p-5 shadow-soft ring-1 dark:bg-gray-900", current ? "ring-2 ring-brand-500" : "ring-gray-100 dark:ring-gray-800")}>
                {current && <span className="brand-gradient absolute -top-2.5 left-5 rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white">Current</span>}
                <div className="text-lg font-bold">{p.name}</div>
                <div className="mt-1 text-3xl font-extrabold tracking-tight">
                  {p.currency === "USD" ? "$" : `${p.currency} `}
                  {num(p.price)}
                  <span className="text-sm font-medium text-gray-500">/{p.interval}</span>
                </div>
                <ul className="mt-4 flex-1 space-y-2 text-sm">
                  {(p.features || []).map((f) => (
                    <li key={f} className="flex gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" /> {f}
                    </li>
                  ))}
                </ul>
                {data.card && p.stripe_price_id ? (
                  <Button className="mt-5" variant={current ? "secondary" : "primary"} loading={busy} disabled={current && a.status === "active"} onClick={() => checkout(p.id)}>
                    {current && a.status === "active" ? "Your plan" : "Choose by card"}
                  </Button>
                ) : (
                  <p className="mt-5 text-xs text-gray-500">Pay by bank transfer to choose this plan.</p>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
