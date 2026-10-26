/**
 * Plans, limits and subscription state. Billing is off unless the super admin turns it on
 * (Admin → Plans) or BILLING_ENABLED=true, so self-hosted single-business installs stay unlimited.
 */
import { one, many, query } from "../db/pool.js";
import { config } from "../config.js";
import { monthKey } from "../lib/time.js";
import { HttpError, PermanentError } from "../lib/errors.js";
import { notify } from "./notifications.js";

const DEFAULTS = { enabled: false, trialDays: 14, trialPlan: "trial", currency: "USD", bankInstructions: "", contact: "" };

export async function billingSettings() {
  const row = await one(`SELECT value FROM platform_settings WHERE key='billing'`);
  const v = { ...DEFAULTS, ...(row?.value || {}) };
  if (config.billingEnabled) v.enabled = true;
  return v;
}

export async function saveBillingSettings(value) {
  await query(
    `INSERT INTO platform_settings (key, value) VALUES ('billing', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [{ ...DEFAULTS, ...value }]
  );
  cache.clear();
}

const cache = new Map(); // accountId -> { at, value }

/** Effective plan for an account: limits, whether it may run, and why not. */
export async function accountPlan(accountId, { fresh = false } = {}) {
  const hit = cache.get(accountId);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.value;
  const billing = await billingSettings();
  const account = await one(`SELECT * FROM accounts WHERE id=$1`, [accountId]);
  const plan = account ? await one(`SELECT * FROM plans WHERE id=$1`, [account.plan]) : null;
  const limits = { ...(plan?.limits || {}), ...(account?.limits || {}) };
  let active = true;
  let reason = null;
  if (billing.enabled && account) {
    const now = Date.now();
    if (account.plan_status === "canceled") [active, reason] = [false, "Your subscription was cancelled. Choose a plan to continue."];
    else if (account.plan_status === "trialing" && account.trial_ends_at && new Date(account.trial_ends_at).getTime() < now) [active, reason] = [false, "Your free trial has ended. Choose a plan to continue."];
    else if (account.plan_status === "past_due") [active, reason] = [false, "Your last payment failed. Update your payment to continue."];
    else if (account.paid_until && new Date(account.paid_until).getTime() < now && !account.stripe_subscription_id && account.plan_status !== "trialing") [active, reason] = [false, "Your plan has expired. Renew it to continue."];
  }
  const value = { billingEnabled: billing.enabled, account, plan, limits: billing.enabled ? limits : {}, active, reason };
  cache.set(accountId, { at: Date.now(), value });
  return value;
}

export const invalidatePlan = (accountId) => cache.delete(accountId);

export async function usageFor(accountId) {
  const u = (await one(`SELECT * FROM usage_counters WHERE account_id=$1 AND month=$2`, [accountId, monthKey()])) || {};
  const s = await one(`SELECT count(*)::int AS n FROM stores WHERE account_id=$1`, [accountId]);
  const m = await one(`SELECT count(*)::int AS n FROM memberships WHERE account_id=$1`, [accountId]);
  return { messages: u.messages || 0, aiReplies: u.ai_replies || 0, marketing: u.marketing_messages || 0, stores: s.n, users: m.n };
}

const LIMIT_TEXT = {
  messages: "WhatsApp messages this month",
  aiReplies: "AI replies this month",
  stores: "stores",
  users: "team members",
};

async function limitReached(accountId, kind) {
  await notify({
    accountId,
    kind: `billing.limit.${kind}`,
    severity: "danger",
    title: `Plan limit reached: ${LIMIT_TEXT[kind]}`,
    body: "Upgrade your plan to keep going.",
    link: "/billing",
  });
}

/**
 * Throws when the account can't do `kind` right now (plan inactive or limit reached).
 * `adding` = how many new items the action creates (stores/users) or sends (messages).
 */
export async function assertWithinPlan(accountId, kind, { adding = 1, http = false } = {}) {
  if (!accountId) return;
  const p = await accountPlan(accountId);
  if (!p.billingEnabled) return;
  const fail = (msg) => {
    throw http ? new HttpError(402, msg) : new PermanentError(msg);
  };
  if (!p.active) fail(p.reason);
  const max = p.limits[kind];
  if (max === undefined || max === null || max < 0) return;
  const usage = await usageFor(accountId);
  if (usage[kind] + adding > Number(max)) {
    const key = `${accountId}:${kind}:${monthKey()}`;
    if (!limitReached.sent?.has(key)) {
      limitReached.sent ||= new Set();
      limitReached.sent.add(key);
      await limitReached(accountId, kind);
    }
    fail(`Your plan allows ${max} ${LIMIT_TEXT[kind]}. Upgrade under Billing & plan.`);
  }
}

export async function listPlans({ all = false } = {}) {
  return many(`SELECT * FROM plans ${all ? "" : "WHERE active"} ORDER BY sort, price`);
}

/** New sign-ups start on the trial when billing is on. */
export async function startTrial(client, accountId) {
  const b = await billingSettings();
  if (!b.enabled) return;
  await client.query(`UPDATE accounts SET plan=$2, plan_status='trialing', trial_ends_at=now() + ($3 || ' days')::interval WHERE id=$1`, [accountId, b.trialPlan || "trial", String(b.trialDays || 14)]);
}
