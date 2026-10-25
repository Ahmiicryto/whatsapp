import { Router } from "express";
import { ah } from "../../lib/errors.js";
import { scopeStoreIds, assertStore } from "../auth.js";
import { enqueue } from "../../queue/queue.js";
import { listProducts } from "../../services/products.js";

const r = Router();

r.get(
  "/products",
  ah(async (req, res) => {
    const storeIds = await scopeStoreIds(req);
    const limit = Math.min(96, Number(req.query.limit || 48));
    const page = Math.max(1, Number(req.query.page || 1));
    const data = await listProducts(storeIds, { q: req.query.q ? String(req.query.q) : "", limit, offset: (page - 1) * limit });
    res.json({ ...data, page, limit });
  })
);

r.post(
  "/stores/:id/products/sync",
  ah(async (req, res) => {
    const store = await assertStore(req, req.params.id, "admin");
    await enqueue("store.products", { storeId: store.id }, { singletonKey: `store:${store.id}:products` });
    res.json({ queued: true });
  })
);

export default r;
