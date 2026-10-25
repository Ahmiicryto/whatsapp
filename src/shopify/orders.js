import { shopifyGraphql, assertNoUserErrors, gid, legacyId, ShopifyError } from "./client.js";

const COD_RE = /cash on delivery|\bcod\b|cash|pay on delivery/i;

function splitTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  return String(tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normAddress(a) {
  if (!a) return null;
  return {
    firstName: a.first_name ?? a.firstName ?? null,
    lastName: a.last_name ?? a.lastName ?? null,
    name: a.name ?? null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    provinceCode: a.province_code ?? a.provinceCode ?? null,
    zip: a.zip ?? null,
    country: a.country ?? null,
    countryCode: a.country_code ?? a.countryCodeV2 ?? a.countryCode ?? null,
    phone: a.phone ?? null,
    latitude: a.latitude ?? null,
    longitude: a.longitude ?? null,
  };
}

/** Webhook (REST-shaped) order payload -> normalized order. */
export function normalizeWebhookOrder(p) {
  const gateways = p.payment_gateway_names?.length ? p.payment_gateway_names : [p.gateway].filter(Boolean);
  const customer = p.customer
    ? {
        shopifyId: p.customer.id ?? null,
        firstName: p.customer.first_name ?? null,
        lastName: p.customer.last_name ?? null,
        phone: p.customer.phone ?? null,
        email: p.customer.email ?? null,
        tags: splitTags(p.customer.tags),
        acceptsMarketing:
          p.buyer_accepts_marketing === true ||
          p.customer.sms_marketing_consent?.state === "subscribed" ||
          p.customer.email_marketing_consent?.state === "subscribed",
      }
    : null;
  return {
    shopifyOrderId: Number(p.id),
    name: p.name,
    email: p.email || p.contact_email || customer?.email || null,
    phoneRaw: p.shipping_address?.phone || p.phone || customer?.phone || p.billing_address?.phone || null,
    phoneCandidates: [p.shipping_address?.phone, p.phone, customer?.phone, p.billing_address?.phone].filter(Boolean),
    customer,
    shippingAddress: normAddress(p.shipping_address || p.billing_address),
    total: Number(p.total_price ?? p.current_total_price ?? 0),
    subtotal: Number(p.subtotal_price ?? 0),
    currency: p.currency || p.presentment_currency,
    gateway: gateways.join(", "),
    isCod: gateways.some((g) => COD_RE.test(g)),
    financialStatus: p.financial_status ?? null,
    fulfillmentStatus: p.fulfillment_status ?? null,
    tags: splitTags(p.tags),
    lineItems: (p.line_items || []).map((li) => ({
      lineItemId: li.id ?? null,
      productId: li.product_id ?? null,
      variantId: li.variant_id ?? null,
      title: li.title || li.name || "Item",
      variantTitle: li.variant_title ?? null,
      sku: li.sku ?? null,
      quantity: Number(li.quantity || 1),
      price: Number(li.price || 0),
    })),
    cancelledAt: p.cancelled_at ?? null,
    createdAt: p.created_at ?? new Date().toISOString(),
    orderStatusUrl: p.order_status_url ?? null,
    checkoutToken: p.checkout_token ?? null,
    discountCodes: (p.discount_codes || []).map((d) => d.code).filter(Boolean),
  };
}

const ORDER_FIELDS = `
  id legacyResourceId name email phone createdAt cancelledAt tags paymentGatewayNames statusPageUrl
  displayFinancialStatus displayFulfillmentStatus currencyCode discountCodes
  totalPriceSet { shopMoney { amount } } subtotalPriceSet { shopMoney { amount } }
  customer { legacyResourceId firstName lastName phone email tags }
  shippingAddress { firstName lastName name address1 address2 city province provinceCode zip country countryCodeV2 phone latitude longitude }
  billingAddress { phone }
  lineItems(first: 50) { nodes { id title variantTitle sku quantity
    originalUnitPriceSet { shopMoney { amount } }
    variant { legacyResourceId } product { legacyResourceId } } }
`;

/** GraphQL order node -> normalized order. */
export function normalizeGraphqlOrder(o) {
  const gateways = o.paymentGatewayNames || [];
  return {
    shopifyOrderId: Number(o.legacyResourceId),
    name: o.name,
    email: o.email || o.customer?.email || null,
    phoneRaw: o.shippingAddress?.phone || o.phone || o.customer?.phone || o.billingAddress?.phone || null,
    phoneCandidates: [o.shippingAddress?.phone, o.phone, o.customer?.phone, o.billingAddress?.phone].filter(Boolean),
    customer: o.customer
      ? {
          shopifyId: Number(o.customer.legacyResourceId),
          firstName: o.customer.firstName,
          lastName: o.customer.lastName,
          phone: o.customer.phone,
          email: o.customer.email,
          tags: o.customer.tags || [],
          acceptsMarketing: false,
        }
      : null,
    shippingAddress: normAddress(o.shippingAddress),
    total: Number(o.totalPriceSet?.shopMoney?.amount || 0),
    subtotal: Number(o.subtotalPriceSet?.shopMoney?.amount || 0),
    currency: o.currencyCode,
    gateway: gateways.join(", "),
    isCod: gateways.some((g) => COD_RE.test(g)),
    financialStatus: o.displayFinancialStatus?.toLowerCase() ?? null,
    fulfillmentStatus: o.displayFulfillmentStatus?.toLowerCase() ?? null,
    tags: o.tags || [],
    lineItems: (o.lineItems?.nodes || []).map((li) => ({
      lineItemId: legacyId(li.id),
      productId: li.product ? Number(li.product.legacyResourceId) : null,
      variantId: li.variant ? Number(li.variant.legacyResourceId) : null,
      title: li.title,
      variantTitle: li.variantTitle,
      sku: li.sku,
      quantity: li.quantity,
      price: Number(li.originalUnitPriceSet?.shopMoney?.amount || 0),
    })),
    cancelledAt: o.cancelledAt,
    createdAt: o.createdAt,
    orderStatusUrl: o.statusPageUrl,
    checkoutToken: null,
    discountCodes: o.discountCodes || [],
  };
}

export async function fetchOrder(store, shopifyOrderId) {
  const data = await shopifyGraphql(store, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, {
    id: gid("Order", shopifyOrderId),
  });
  return data.order ? normalizeGraphqlOrder(data.order) : null;
}

/** Orders updated since `since` (for reconciliation/backfill), paginated. */
export async function fetchOrdersSince(store, since, maxPages = 10) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await shopifyGraphql(
      store,
      `query($q: String!, $after: String) {
        orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ORDER_FIELDS} }
        }
      }`,
      { q: `updated_at:>='${new Date(since).toISOString()}'`, after }
    );
    out.push(...data.orders.nodes.map(normalizeGraphqlOrder));
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return out;
}

/** { variantId: imageUrl } using the variant image, falling back to the product's featured media. */
export async function fetchVariantImages(store, variantIds, productIds = []) {
  const ids = [
    ...new Set(variantIds.filter(Boolean).map((v) => gid("ProductVariant", v))),
    ...new Set(productIds.filter(Boolean).map((p) => gid("Product", p))),
  ];
  if (!ids.length) return { byVariant: {}, byProduct: {} };
  const data = await shopifyGraphql(
    store,
    `query($ids: [ID!]!) { nodes(ids: $ids) {
       ... on ProductVariant { id legacyResourceId image { url }
             product { legacyResourceId featuredMedia { preview { image { url } } } } }
       ... on Product { id legacyResourceId featuredMedia { preview { image { url } } } }
    } }`,
    { ids }
  );
  const byVariant = {};
  const byProduct = {};
  for (const n of data.nodes || []) {
    if (!n) continue;
    if (n.id.includes("ProductVariant")) {
      const url = n.image?.url || n.product?.featuredMedia?.preview?.image?.url;
      if (url) byVariant[n.legacyResourceId] = url;
      const purl = n.product?.featuredMedia?.preview?.image?.url;
      if (purl && n.product) byProduct[n.product.legacyResourceId] = purl;
    } else {
      const url = n.featuredMedia?.preview?.image?.url;
      if (url) byProduct[n.legacyResourceId] = url;
    }
  }
  return { byVariant, byProduct };
}

export async function addTags(store, shopifyOrderId, tags) {
  const list = tags.filter(Boolean);
  if (!list.length) return;
  const data = await shopifyGraphql(
    store,
    `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
    { id: gid("Order", shopifyOrderId), tags: list }
  );
  assertNoUserErrors(data.tagsAdd, "tagsAdd");
}

export async function removeTags(store, shopifyOrderId, tags) {
  const list = tags.filter(Boolean);
  if (!list.length) return;
  const data = await shopifyGraphql(
    store,
    `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`,
    { id: gid("Order", shopifyOrderId), tags: list }
  );
  assertNoUserErrors(data.tagsRemove, "tagsRemove");
}

export async function updateShippingAddress(store, shopifyOrderId, addr) {
  const input = {
    address1: addr.address1 || "",
    address2: addr.address2 || null,
    city: addr.city || null,
    zip: addr.zip || null,
    firstName: addr.firstName || null,
    lastName: addr.lastName || null,
    phone: addr.phone || null,
  };
  if (addr.countryCode) input.countryCode = addr.countryCode;
  if (addr.provinceCode) input.provinceCode = addr.provinceCode;
  const data = await shopifyGraphql(
    store,
    `mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
    { input: { id: gid("Order", shopifyOrderId), shippingAddress: input } }
  );
  assertNoUserErrors(data.orderUpdate, "orderUpdate");
}

export async function addOrderNote(store, shopifyOrderId, note) {
  const data = await shopifyGraphql(
    store,
    `mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { field message } } }`,
    { input: { id: gid("Order", shopifyOrderId), note } }
  );
  assertNoUserErrors(data.orderUpdate, "orderUpdate");
}

export async function cancelOrder(store, shopifyOrderId, { restock = true } = {}) {
  const data = await shopifyGraphql(
    store,
    `mutation($id: ID!, $restock: Boolean!) {
      orderCancel(orderId: $id, reason: CUSTOMER, refund: false, restock: $restock, notifyCustomer: false) {
        job { id } orderCancelUserErrors { field message }
      }
    }`,
    { id: gid("Order", shopifyOrderId), restock }
  );
  assertNoUserErrors(data.orderCancel, "orderCancel");
}

/**
 * Unique single-use percentage discount code. Newer API versions use `context`,
 * older ones `customerSelection` — try both.
 */
export async function createDiscountCode(store, { code, percent, days, title }) {
  const base = {
    title: title || `WhatsApp ${code}`,
    code,
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + (days || 7) * 86400000).toISOString(),
    customerGets: { value: { percentage: Math.min(1, Number(percent) / 100) }, items: { all: true } },
    appliesOncePerCustomer: true,
    usageLimit: 1,
  };
  const mutation = `mutation($d: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } }
  }`;
  let lastErr;
  for (const variant of [{ context: { all: "ALL" } }, { customerSelection: { all: true } }]) {
    try {
      const data = await shopifyGraphql(store, mutation, { d: { ...base, ...variant } });
      assertNoUserErrors(data.discountCodeBasicCreate, "discountCodeBasicCreate");
      return code;
    } catch (err) {
      lastErr = err;
      if (!/context|customerSelection|argument|field/i.test(err.message)) break;
    }
  }
  throw lastErr || new ShopifyError("discount creation failed");
}
