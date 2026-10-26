import { shopifyGraphql, assertNoUserErrors, gid } from "./client.js";

/** Fulfill every open fulfillment order of a Shopify order with the courier's tracking info. */
export async function fulfillOrder(store, shopifyOrderId, tracking) {
  const data = await shopifyGraphql(
    store,
    `query($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status } } } }`,
    { id: gid("Order", shopifyOrderId) }
  );
  const open = (data.order?.fulfillmentOrders?.nodes || []).filter((f) => ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(f.status));
  if (!open.length) return null;
  const res = await shopifyGraphql(
    store,
    `mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id } userErrors { field message } } }`,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })),
        trackingInfo: { company: tracking.company || null, number: tracking.number, url: tracking.url || null },
        notifyCustomer: false,
      },
    }
  );
  assertNoUserErrors(res.fulfillmentCreate, "fulfillmentCreate");
  return res.fulfillmentCreate.fulfillment?.id || null;
}

/**
 * Add a variant to an existing order (upsell accepted on WhatsApp), optionally at a lower price.
 * Uses Shopify order editing: begin → add variant → (discount) → commit.
 */
export async function addVariantToOrder(store, shopifyOrderId, { variantId, quantity = 1, discountPercent = 0, note }) {
  const begin = await shopifyGraphql(
    store,
    `mutation($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }`,
    { id: gid("Order", shopifyOrderId) }
  );
  assertNoUserErrors(begin.orderEditBegin, "orderEditBegin");
  const calcId = begin.orderEditBegin.calculatedOrder.id;
  const add = await shopifyGraphql(
    store,
    `mutation($id: ID!, $variantId: ID!, $qty: Int!) { orderEditAddVariant(id: $id, variantId: $variantId, quantity: $qty, allowDuplicates: true) {
       calculatedLineItem { id } userErrors { field message } } }`,
    { id: calcId, variantId: gid("ProductVariant", variantId), qty: quantity }
  );
  assertNoUserErrors(add.orderEditAddVariant, "orderEditAddVariant");
  if (discountPercent > 0) {
    const disc = await shopifyGraphql(
      store,
      `mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) { orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
         userErrors { field message } } }`,
      { id: calcId, lineItemId: add.orderEditAddVariant.calculatedLineItem.id, discount: { percentValue: Number(discountPercent), description: "WhatsApp offer" } }
    );
    assertNoUserErrors(disc.orderEditAddLineItemDiscount, "orderEditAddLineItemDiscount");
  }
  const commit = await shopifyGraphql(
    store,
    `mutation($id: ID!, $note: String) { orderEditCommit(id: $id, notifyCustomer: false, staffNote: $note) { order { id totalPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
    { id: calcId, note: note || "Added from WhatsApp upsell" }
  );
  assertNoUserErrors(commit.orderEditCommit, "orderEditCommit");
  return Number(commit.orderEditCommit.order?.totalPriceSet?.shopMoney?.amount || 0);
}
