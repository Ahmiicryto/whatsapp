/** Stripe webhook events: subscriptions for plans, one-off payments for advance payments. */
import { one, query } from "../db/pool.js";
import { invalidatePlan } from "./billing.js";
import { notify } from "./notifications.js";
import { getStoreContext } from "./stores.js";
import { markAdvancePaid } from "./fraud.js";
import { logger } from "../logger.js";

const STATUS = { active: "active", trialing: "trialing", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete_expired: "canceled", incomplete: "past_due" };

export async function handleStripeEvent(event) {
  const o = event.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed": {
      if (o.metadata?.kind === "advance" && o.payment_status === "paid") {
        const store = await getStoreContext(Number(o.metadata.storeId));
        if (store) await markAdvancePaid(store, Number(o.metadata.orderId), { source: "card payment" });
        return;
      }
      if (o.mode === "subscription" && o.metadata?.accountId) {
        const accountId = Number(o.metadata.accountId);
        await query(
          `UPDATE accounts SET plan=COALESCE($2, plan), plan_status='active', stripe_customer_id=COALESCE($3, stripe_customer_id), stripe_subscription_id=$4, status='active' WHERE id=$1`,
          [accountId, o.metadata.planId || null, o.customer || null, o.subscription || null]
        );
        invalidatePlan(accountId);
        await notify({ accountId, kind: "billing.paid", severity: "success", title: "Subscription active 🎉", body: `Plan: ${o.metadata.planId}`, link: "/billing" });
      }
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created":
    case "customer.subscription.deleted": {
      const accountId = Number(o.metadata?.accountId) || (await one(`SELECT id FROM accounts WHERE stripe_subscription_id=$1 OR stripe_customer_id=$2`, [o.id, o.customer]))?.id;
      if (!accountId) return;
      const status = event.type === "customer.subscription.deleted" ? "canceled" : STATUS[o.status] || "active";
      await query(
        `UPDATE accounts SET plan_status=$2, stripe_subscription_id=$3, paid_until=to_timestamp($4), plan=COALESCE($5, plan) WHERE id=$1`,
        [accountId, status, status === "canceled" ? null : o.id, o.current_period_end || o.items?.data?.[0]?.current_period_end || Date.now() / 1000, o.metadata?.planId || null]
      );
      invalidatePlan(accountId);
      if (status === "canceled") await notify({ accountId, kind: "billing.canceled", severity: "danger", title: "Subscription cancelled", body: "Automations stop until you choose a plan.", link: "/billing" });
      return;
    }
    case "invoice.payment_failed": {
      const acc = await one(`SELECT id FROM accounts WHERE stripe_customer_id=$1`, [o.customer]);
      if (!acc) return;
      await query(`UPDATE accounts SET plan_status='past_due' WHERE id=$1`, [acc.id]);
      invalidatePlan(acc.id);
      await notify({ accountId: acc.id, kind: "billing.failed", severity: "danger", title: "Payment failed", body: "Update your card to keep your automations running.", link: "/billing" });
      return;
    }
    default:
      logger.info({ type: event.type }, "ignored stripe event");
  }
}
