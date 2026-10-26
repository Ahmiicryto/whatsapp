import { Router } from "express";
import { z } from "zod";
import { one, query } from "../../db/pool.js";
import { ah, badRequest } from "../../lib/errors.js";
import { config } from "../../config.js";
import { requireRole } from "../auth.js";
import { accountPlan, usageFor, listPlans, billingSettings } from "../../services/billing.js";
import { stripeConfigured, stripeRequest } from "../../services/stripe.js";

const r = Router();

r.get(
  "/billing",
  ah(async (req, res) => {
    const [p, usage, plans, settings] = await Promise.all([accountPlan(req.accountId, { fresh: true }), usageFor(req.accountId), listPlans(), billingSettings()]);
    res.json({
      enabled: p.billingEnabled,
      active: p.active,
      reason: p.reason,
      account: { plan: p.account?.plan, status: p.account?.plan_status, trialEndsAt: p.account?.trial_ends_at, paidUntil: p.account?.paid_until, hasStripe: !!p.account?.stripe_customer_id },
      limits: { ...(p.plan?.limits || {}), ...(p.account?.limits || {}) },
      usage,
      plans: plans.filter((x) => x.id !== "trial" || p.account?.plan === "trial"),
      card: stripeConfigured(),
      bankInstructions: settings.bankInstructions,
      contact: settings.contact,
    });
  })
);

r.post(
  "/billing/checkout",
  requireRole("owner"),
  ah(async (req, res) => {
    const { planId } = z.object({ planId: z.string() }).parse(req.body);
    const plan = await one(`SELECT * FROM plans WHERE id=$1 AND active`, [planId]);
    if (!plan?.stripe_price_id) throw badRequest("This plan can't be paid by card yet. Use the bank transfer instructions, or ask the admin to add a Stripe price.");
    const account = await one(`SELECT * FROM accounts WHERE id=$1`, [req.accountId]);
    let customer = account.stripe_customer_id;
    if (!customer) {
      customer = (await stripeRequest("/customers", { email: req.user.email, name: account.name, metadata: { accountId: String(account.id) } })).id;
      await query(`UPDATE accounts SET stripe_customer_id=$2 WHERE id=$1`, [account.id, customer]);
    }
    const session = await stripeRequest("/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: String(account.id),
      line_items: { 0: { price: plan.stripe_price_id, quantity: 1 } },
      success_url: `${config.baseUrl}/billing?paid=1`,
      cancel_url: `${config.baseUrl}/billing`,
      metadata: { kind: "subscription", accountId: String(account.id), planId: plan.id },
      subscription_data: { metadata: { accountId: String(account.id), planId: plan.id } },
    });
    res.json({ url: session.url });
  })
);

r.post(
  "/billing/portal",
  requireRole("owner"),
  ah(async (req, res) => {
    const account = await one(`SELECT stripe_customer_id FROM accounts WHERE id=$1`, [req.accountId]);
    if (!account?.stripe_customer_id) throw badRequest("No card subscription yet");
    const s = await stripeRequest("/billing_portal/sessions", { customer: account.stripe_customer_id, return_url: `${config.baseUrl}/billing` });
    res.json({ url: s.url });
  })
);

export default r;
