import { useEffect, useState } from "react";
import { Boxes, ExternalLink, ImageOff, RefreshCw, Search } from "lucide-react";
import { useApi, post, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { money, num, ago } from "../lib/format.js";
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Skeleton, Modal, cx, useAction } from "../components/ui.jsx";

const PAGE = 48;

function ProductCard({ p, onOpen }) {
  const cur = p.currency || undefined;
  const price = Number(p.price_min) === Number(p.price_max) || !p.price_max ? money(p.price_min, cur) : `${money(p.price_min, cur)} – ${money(p.price_max, cur)}`;
  return (
    <button
      onClick={() => onOpen(p)}
      className="animate-rise group overflow-hidden rounded-2xl border border-white/60 bg-white text-left shadow-soft transition hover:-translate-y-1 hover:shadow-lift focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-800 dark:bg-gray-900/80"
    >
      <div className="relative aspect-square overflow-hidden bg-gray-100 dark:bg-gray-800">
        {p.image_url ? (
          <img src={p.image_url} alt={p.title} loading="lazy" decoding="async" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-300 dark:text-gray-600">
            <ImageOff className="h-10 w-10" />
          </div>
        )}
        {p.status !== "active" && (
          <Badge tone="gray" className="absolute left-2 top-2 capitalize">
            {p.status?.toLowerCase()}
          </Badge>
        )}
        {Number(p.sold_30d) > 0 && (
          <span className="absolute right-2 top-2 rounded-full bg-navy-950/80 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">{num(p.sold_30d)} sold · 30d</span>
        )}
      </div>
      <div className="p-3.5">
        <div className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug">{p.title}</div>
        <div className="mt-1.5 truncate text-sm font-bold text-brand-700 dark:text-brand-400">{price}</div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-gray-400">
          <span className="truncate">{p.store_name}</span>
          {p.inventory != null && <span className={cx("shrink-0", Number(p.inventory) <= 0 ? "text-red-600" : "text-gray-500")}>{num(p.inventory)} in stock</span>}
        </div>
      </div>
    </button>
  );
}

function ProductModal({ p, onClose }) {
  const images = [...new Set([p.image_url, ...(p.images || [])].filter(Boolean))];
  const [active, setActive] = useState(0);
  return (
    <Modal open wide onClose={onClose} title={p.title}>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <div className="aspect-square overflow-hidden rounded-2xl bg-gray-100 dark:bg-gray-800">
            {images[active] ? <img src={images[active]} alt={p.title} className="h-full w-full object-cover" /> : <ImageOff className="m-auto h-full w-10 text-gray-300" />}
          </div>
          {images.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
              {images.map((img, i) => (
                <button key={img} onClick={() => setActive(i)} aria-label={`Photo ${i + 1}`} className={cx("h-14 w-14 shrink-0 overflow-hidden rounded-lg ring-2", i === active ? "ring-brand-500" : "ring-transparent")}>
                  <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={p.status === "active" ? "green" : "gray"}>{p.status}</Badge>
            {p.product_type && <Badge>{p.product_type}</Badge>}
            {p.vendor && <Badge tone="blue">{p.vendor}</Badge>}
          </div>
          <div className="text-xs text-gray-500">
            {p.store_name} · updated {ago(p.updated_at)}
          </div>
          <div className="overflow-hidden rounded-xl ring-1 ring-gray-200 dark:ring-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-800/50">
                <tr>
                  <th className="px-3 py-2 font-semibold">Variant</th>
                  <th className="px-3 py-2 font-semibold">SKU</th>
                  <th className="px-3 py-2 text-right font-semibold">Price</th>
                  <th className="px-3 py-2 text-right font-semibold">Stock</th>
                </tr>
              </thead>
              <tbody>
                {(p.variants || []).map((v) => (
                  <tr key={v.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {v.image && <img src={v.image} alt="" className="h-7 w-7 rounded object-cover" loading="lazy" />}
                        {v.title}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-gray-500">{v.sku || "—"}</td>
                    <td className="px-3 py-2 text-right">{money(v.price, p.currency || undefined)}</td>
                    <td className="px-3 py-2 text-right">{v.inventory ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500">These photos are sent with order confirmations on WhatsApp automatically.</p>
          {p.online_url && (
            <a href={p.online_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-brand-700 hover:underline dark:text-brand-400">
              View in store <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default function Products() {
  const { storeId, stores, can } = useSession();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useApi(`/products${qs({ storeId, q: query, page, limit: PAGE })}`);
  const syncIds = storeId === "all" ? stores.map((s) => s.id) : [Number(storeId)];

  async function sync() {
    await run(() => Promise.all(syncIds.map((id) => post(`/stores/${id}/products/sync`))), "Syncing products from Shopify… this takes a minute.");
    setTimeout(reload, 4000);
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  return (
    <div className="space-y-5">
      <PageHeader
        icon={Boxes}
        title="Products"
        subtitle={data ? `${num(data.total)} products with photos, synced from Shopify` : "Your Shopify catalog with photos"}
        actions={
          can("admin") &&
          syncIds.length > 0 && (
            <Button variant="secondary" loading={busy} onClick={sync}>
              <RefreshCw className="h-4 w-4" /> Sync from Shopify
            </Button>
          )
        }
      />
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, SKU, vendor or type" aria-label="Search products" />
      </div>
      <ErrorBox error={error} />
      {loading && !data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl bg-white shadow-soft dark:bg-gray-900">
              <Skeleton className="aspect-square rounded-none" />
              <div className="space-y-2 p-3.5">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : data?.rows.length === 0 ? (
        <Card>
          <Empty
            title={query ? "No products match your search" : "No products yet"}
            action={!query && can("admin") && syncIds.length > 0 && <Button onClick={sync} loading={busy}>Import products from Shopify</Button>}
          >
            {!query && "Product photos, prices and stock are imported from Shopify and kept up to date automatically."}
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {data?.rows.map((p) => (
            <ProductCard key={p.id} p={p} onOpen={setOpen} />
          ))}
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="text-gray-500">
            Page {page} of {pages}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
      {open && <ProductModal p={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
