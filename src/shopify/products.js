import { shopifyGraphql, legacyId } from "./client.js";

const PRODUCT_FIELDS = `
  id title handle status productType vendor tags onlineStoreUrl totalInventory
  featuredMedia { preview { image { url } } }
  media(first: 10) { nodes { preview { image { url altText } } } }
  priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount } }
  variants(first: 50) { nodes { legacyResourceId title sku price inventoryQuantity image { url } } }
`;

export function normalizeGraphqlProduct(p) {
  const images = (p.media?.nodes || []).map((m) => m.preview?.image?.url).filter(Boolean);
  return {
    shopifyProductId: legacyId(p.id),
    title: p.title,
    handle: p.handle,
    status: p.status?.toLowerCase() || null,
    productType: p.productType || null,
    vendor: p.vendor || null,
    tags: p.tags || [],
    imageUrl: p.featuredMedia?.preview?.image?.url || images[0] || null,
    images,
    priceMin: Number(p.priceRangeV2?.minVariantPrice?.amount ?? 0),
    priceMax: Number(p.priceRangeV2?.maxVariantPrice?.amount ?? 0),
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode || null,
    inventory: p.totalInventory ?? null,
    onlineUrl: p.onlineStoreUrl || null,
    variants: (p.variants?.nodes || []).map((v) => ({
      id: Number(v.legacyResourceId),
      title: v.title,
      sku: v.sku,
      price: Number(v.price || 0),
      inventory: v.inventoryQuantity ?? null,
      image: v.image?.url || null,
    })),
  };
}

/** Webhook (REST-shaped) product payload -> normalized product. */
export function normalizeWebhookProduct(p) {
  const images = (p.images || []).map((i) => i.src).filter(Boolean);
  const prices = (p.variants || []).map((v) => Number(v.price || 0));
  return {
    shopifyProductId: Number(p.id),
    title: p.title,
    handle: p.handle,
    status: p.status || null,
    productType: p.product_type || null,
    vendor: p.vendor || null,
    tags: String(p.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
    imageUrl: p.image?.src || images[0] || null,
    images,
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    currency: null,
    inventory: (p.variants || []).reduce((s, v) => s + Number(v.inventory_quantity || 0), 0),
    onlineUrl: null,
    variants: (p.variants || []).map((v) => ({
      id: Number(v.id),
      title: v.title,
      sku: v.sku,
      price: Number(v.price || 0),
      inventory: v.inventory_quantity ?? null,
      image: (p.images || []).find((i) => i.id === v.image_id)?.src || null,
    })),
  };
}

/** All products (paginated). */
export async function fetchAllProducts(store, maxPages = 40) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await shopifyGraphql(
      store,
      `query($after: String) { products(first: 50, after: $after, sortKey: UPDATED_AT, reverse: true) {
         pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`,
      { after }
    );
    out.push(...data.products.nodes.map(normalizeGraphqlProduct));
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return out;
}

/** Unit cost per variant (Shopify "Cost per item"). Needs read_inventory; returns {} when not allowed. */
export async function fetchVariantCosts(store, maxPages = 20) {
  const out = {};
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await shopifyGraphql(
      store,
      `query($after: String) { productVariants(first: 250, after: $after) { pageInfo { hasNextPage endCursor }
         nodes { legacyResourceId inventoryItem { unitCost { amount } } } } }`,
      { after }
    );
    for (const v of data.productVariants.nodes) {
      const amount = v.inventoryItem?.unitCost?.amount;
      if (amount !== undefined && amount !== null) out[Number(v.legacyResourceId)] = Number(amount);
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }
  return out;
}
