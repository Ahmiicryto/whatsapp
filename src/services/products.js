import { one, many, query } from "../db/pool.js";
import { fetchAllProducts, fetchVariantCosts } from "../shopify/products.js";
import { enqueue } from "../queue/queue.js";
import { logger } from "../logger.js";

export async function upsertProduct(store, p) {
  const before = await one(`SELECT variants, inventory FROM products WHERE store_id=$1 AND shopify_product_id=$2`, [store.id, p.shopifyProductId]);
  await query(
    `INSERT INTO products (store_id, shopify_product_id, title, handle, status, product_type, vendor, tags, image_url, images,
        price_min, price_max, currency, inventory, variants, online_url, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (store_id, shopify_product_id) DO UPDATE SET title=EXCLUDED.title, handle=EXCLUDED.handle, status=EXCLUDED.status,
       product_type=EXCLUDED.product_type, vendor=EXCLUDED.vendor, tags=EXCLUDED.tags, image_url=EXCLUDED.image_url, images=EXCLUDED.images,
       price_min=EXCLUDED.price_min, price_max=EXCLUDED.price_max, currency=COALESCE(EXCLUDED.currency, products.currency),
       inventory=EXCLUDED.inventory, variants=EXCLUDED.variants, online_url=COALESCE(EXCLUDED.online_url, products.online_url), updated_at=now()`,
    [
      store.id, p.shopifyProductId, p.title, p.handle, p.status, p.productType, p.vendor, p.tags, p.imageUrl,
      JSON.stringify(p.images), p.priceMin, p.priceMax, p.currency || store.currency, p.inventory, JSON.stringify(p.variants), p.onlineUrl,
    ]
  );
  // Back in stock: a variant (or the product) went from 0 to available -> message the people waiting for it.
  if (before && store.settings?.backInStock?.enabled !== false) {
    const old = Object.fromEntries((before.variants || []).map((v) => [v.id, Number(v.inventory ?? 0)]));
    const restocked = (p.variants || []).filter((v) => Number(v.inventory ?? 0) > 0 && old[v.id] !== undefined && old[v.id] <= 0).map((v) => v.id);
    const productRestocked = Number(before.inventory ?? 0) <= 0 && Number(p.inventory ?? 0) > 0;
    if (restocked.length || productRestocked) {
      await enqueue("stock.restocked", { storeId: store.id, productId: p.shopifyProductId, variantIds: restocked, any: productRestocked });
    }
  }
}

/** Full catalog sync; also fills missing order item images from the catalog. */
export async function syncProducts(store) {
  const products = await fetchAllProducts(store);
  for (const p of products) await upsertProduct(store, p);
  await fillOrderItemImages(store.id);
  try {
    const costs = await fetchVariantCosts(store);
    if (Object.keys(costs).length) {
      await query(
        `UPDATE products p SET variants = (SELECT jsonb_agg(CASE WHEN ($2::jsonb ? (v->>'id')) THEN v || jsonb_build_object('cost', ($2::jsonb ->> (v->>'id'))::numeric) ELSE v END) FROM jsonb_array_elements(p.variants) v),
                cost = (SELECT avg(($2::jsonb ->> (v->>'id'))::numeric) FROM jsonb_array_elements(p.variants) v WHERE $2::jsonb ? (v->>'id'))
          WHERE p.store_id=$1 AND jsonb_array_length(p.variants) > 0`,
        [store.id, JSON.stringify(costs)]
      );
    }
  } catch (err) {
    logger.info({ store: store.id, err: err.message }, "product costs not available (needs read_inventory scope)");
  }
  await fillOrderItemCosts(store.id);
  return products.length;
}

export async function deleteProduct(storeId, shopifyProductId) {
  await query(`DELETE FROM products WHERE store_id=$1 AND shopify_product_id=$2`, [storeId, shopifyProductId]);
}

/** Variant image, else product image, for order items that have none. */
export async function fillOrderItemImages(storeId, orderId = null) {
  await query(
    `UPDATE order_items i SET image_url = COALESCE(
        (SELECT v->>'image' FROM products p, jsonb_array_elements(p.variants) v
          WHERE p.store_id=i.store_id AND (v->>'id')::bigint = i.variant_id AND v->>'image' IS NOT NULL LIMIT 1),
        (SELECT p.image_url FROM products p WHERE p.store_id=i.store_id AND p.shopify_product_id=i.product_id))
      WHERE i.store_id=$1 AND i.image_url IS NULL ${orderId ? "AND i.order_id=$2" : ""}`,
    orderId ? [storeId, orderId] : [storeId]
  );
}

export async function productImageFor(storeId, productId, variantId) {
  const row = await one(
    `SELECT COALESCE((SELECT v->>'image' FROM jsonb_array_elements(variants) v WHERE (v->>'id')::bigint=$3 AND v->>'image' IS NOT NULL LIMIT 1), image_url) AS url
       FROM products WHERE store_id=$1 AND shopify_product_id=$2`,
    [storeId, productId, variantId ?? 0]
  );
  return row?.url || null;
}

export async function listProducts(storeIds, { q, limit = 48, offset = 0 } = {}) {
  const params = [storeIds];
  let where = "p.store_id = ANY($1)";
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (p.title ILIKE $${params.length} OR p.vendor ILIKE $${params.length} OR p.product_type ILIKE $${params.length} OR EXISTS (SELECT 1 FROM jsonb_array_elements(p.variants) v WHERE v->>'sku' ILIKE $${params.length}))`;
  }
  const rows = await many(
    `SELECT p.*, s.name AS store_name, s.shopify_domain,
            (SELECT COALESCE(sum(i.quantity),0) FROM order_items i JOIN orders o ON o.id=i.order_id
              WHERE i.store_id=p.store_id AND i.product_id=p.shopify_product_id AND o.shopify_created_at > now() - interval '30 days') AS sold_30d
       FROM products p JOIN stores s ON s.id=p.store_id WHERE ${where}
      ORDER BY p.status='active' DESC, p.updated_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params
  );
  const total = await one(`SELECT count(*)::int AS n FROM products p WHERE ${where}`, params);
  return { rows, total: total.n };
}

/** Unit cost for order items: manual override > variant cost > product average cost. */
export async function fillOrderItemCosts(storeId, orderId = null) {
  await query(
    `UPDATE order_items i SET unit_cost = COALESCE(
        (SELECT p.cost_override FROM products p WHERE p.store_id=i.store_id AND p.shopify_product_id=i.product_id),
        (SELECT (v->>'cost')::numeric FROM products p, jsonb_array_elements(p.variants) v
          WHERE p.store_id=i.store_id AND (v->>'id')::bigint = i.variant_id AND v->>'cost' IS NOT NULL LIMIT 1),
        (SELECT p.cost FROM products p WHERE p.store_id=i.store_id AND p.shopify_product_id=i.product_id))
      WHERE i.store_id=$1 ${orderId ? "AND i.order_id=$2" : "AND i.unit_cost IS NULL"}`,
    orderId ? [storeId, orderId] : [storeId]
  );
}

/** Search the catalog for the AI agent / inbox product picker. */
export async function searchProducts(storeId, text, limit = 5) {
  const words = String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 6);
  if (!words.length) return [];
  const params = [storeId, words.map((w) => `%${w}%`)];
  return many(
    `SELECT shopify_product_id, title, image_url, price_min, price_max, currency, inventory, online_url, handle, variants
       FROM products WHERE store_id=$1 AND status <> 'archived' AND title ILIKE ANY($2)
      ORDER BY (inventory > 0) DESC NULLS LAST, updated_at DESC LIMIT ${Number(limit)}`,
    params
  );
}
