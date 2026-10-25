import { shopifyGraphql, assertNoUserErrors, gid, ShopifyError } from "../shopify/client.js";
import { addTags } from "../shopify/orders.js";

const DONE_TAG = "bundle-split";

async function variantIdBySku(store, sku) {
  const data = await shopifyGraphql(
    store,
    `query($q: String!) { productVariants(first: 1, query: $q) { nodes { id sku } } }`,
    { q: `sku:${JSON.stringify(String(sku))}` }
  );
  const node = data.productVariants.nodes.find((n) => n.sku === sku) || data.productVariants.nodes[0];
  return node?.id || null;
}

/**
 * Replaces/augments bundle SKUs with their component SKUs using Shopify order editing
 * (begin -> add variants [-> zero the bundle line] -> commit). Idempotent via the "bundle-split" tag.
 * rules: [{ bundleSku, components: [{ sku, quantity }] }]
 */
export async function splitBundles(store, order, items) {
  const cfg = store.settings.bundles;
  if (!cfg.enabled || !cfg.rules?.length) return { changed: false };
  if ((order.shopify_tags || []).includes(DONE_TAG)) return { changed: false };
  const matches = items.filter((i) => cfg.rules.some((r) => r.bundleSku && r.bundleSku === i.sku));
  if (!matches.length) return { changed: false };

  const begin = await shopifyGraphql(
    store,
    `mutation($id: ID!) { orderEditBegin(id: $id) {
       calculatedOrder { id lineItems(first: 100) { nodes { id sku quantity } } }
       userErrors { field message } } }`,
    { id: gid("Order", order.shopify_order_id) }
  );
  assertNoUserErrors(begin.orderEditBegin, "orderEditBegin");
  const calc = begin.orderEditBegin.calculatedOrder;

  for (const item of matches) {
    const rule = cfg.rules.find((r) => r.bundleSku === item.sku);
    for (const comp of rule.components || []) {
      const variantId = await variantIdBySku(store, comp.sku);
      if (!variantId) throw new ShopifyError(`No variant found for component SKU ${comp.sku}`);
      const add = await shopifyGraphql(
        store,
        `mutation($id: ID!, $variantId: ID!, $quantity: Int!) {
           orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
             calculatedLineItem { id } userErrors { field message } } }`,
        { id: calc.id, variantId, quantity: Number(comp.quantity || 1) * Number(item.quantity) }
      );
      assertNoUserErrors(add.orderEditAddVariant, "orderEditAddVariant");
    }
    if (cfg.removeBundleLine) {
      const line = calc.lineItems.nodes.find((l) => l.sku === item.sku && l.quantity > 0);
      if (line) {
        const set = await shopifyGraphql(
          store,
          `mutation($id: ID!, $lineItemId: ID!) { orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: 0, restock: false) {
             calculatedLineItem { id } userErrors { field message } } }`,
          { id: calc.id, lineItemId: line.id }
        );
        assertNoUserErrors(set.orderEditSetQuantity, "orderEditSetQuantity");
      }
    }
  }

  const commit = await shopifyGraphql(
    store,
    `mutation($id: ID!) { orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Bundle split by WhatsApp automation") {
       order { id } userErrors { field message } } }`,
    { id: calc.id }
  );
  assertNoUserErrors(commit.orderEditCommit, "orderEditCommit");
  await addTags(store, order.shopify_order_id, [DONE_TAG]);
  return { changed: true, bundles: matches.length };
}
