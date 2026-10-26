import { useState } from "react";
import { Link } from "react-router-dom";
import { Eye, EyeOff, MessageSquareHeart, Star } from "lucide-react";
import { useApi, put, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago, num } from "../lib/format.js";
import { Badge, Button, Card, Empty, Input, PageHeader, Stat, Tabs, useAction } from "../components/ui.jsx";

function Stars({ n }) {
  return (
    <span className="inline-flex" aria-label={`${n} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-4 w-4 ${i <= n ? "fill-amber-400 text-amber-400" : "text-gray-300 dark:text-gray-600"}`} />
      ))}
    </span>
  );
}

export default function Reviews() {
  const { storeId, can } = useSession();
  const [status, setStatus] = useState("");
  const { data, reload } = useApi(`/reviews${qs({ storeId, status })}`);
  const [run] = useAction();
  const s = data?.stats;
  const setReview = (id, st) => run(() => put(`/reviews/${id}`, { status: st }), st === "published" ? "Published" : "Hidden").then(reload);
  return (
    <div className="space-y-5">
      <PageHeader icon={MessageSquareHeart} title="Reviews" subtitle="Ratings and photos collected on WhatsApp after delivery" />
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat icon={Star} label="Average rating" value={s.average ? `${s.average} ★` : "—"} sub={`${num(s.rated)} ratings`} tone="amber" />
          <Stat icon={Eye} label="Published" value={num(s.published)} tone="green" />
          <Stat icon={MessageSquareHeart} label="Waiting for answer" value={num(s.requested)} />
          <Stat icon={EyeOff} label="Unhappy (1–2★)" value={num(s.unhappy)} tone={s.unhappy ? "red" : "gray"} />
        </div>
      )}
      {data?.feedUrl && (
        <Card title="Show reviews on your website">
          <p className="mb-2 text-sm text-gray-500">This JSON feed returns published reviews (add <code>?product=PRODUCT_ID</code> for one product). Your theme developer can display it in a few lines.</p>
          <Input readOnly value={data.feedUrl} onFocus={(e) => e.target.select()} />
        </Card>
      )}
      <Tabs value={status} onChange={setStatus} tabs={[{ value: "", label: "All" }, { value: "pending", label: "To review" }, { value: "published", label: "Published" }, { value: "hidden", label: "Hidden" }]} />
      {data?.rows.length === 0 ? (
        <Card>
          <Empty title="No reviews yet">Turn on Store → Sales & delivery → Collect reviews on WhatsApp. Customers are asked a few days after delivery.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.rows.map((r) => (
            <Card key={r.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{r.customer_name || "Customer"}</div>
                  <div className="text-xs text-gray-500">
                    {r.order_id ? <Link className="hover:underline" to={`/orders/${r.order_id}`}>{r.order_name}</Link> : null} · {ago(r.created_at)}
                  </div>
                </div>
                <Badge tone={{ published: "green", hidden: "gray", pending: "amber", requested: "gray" }[r.status]}>{r.status}</Badge>
              </div>
              <div className="mt-2">{r.rating ? <Stars n={r.rating} /> : <span className="text-xs text-gray-400">No rating yet</span>}</div>
              {r.product_title && <div className="mt-1 text-xs text-gray-500">{r.product_title}</div>}
              {r.body && <p className="mt-2 whitespace-pre-wrap text-sm">{r.body}</p>}
              {r.media?.length > 0 && (
                <div className="mt-2 flex gap-2">
                  {r.media.map((m) => (
                    <a key={m.url} href={m.url} target="_blank" rel="noreferrer">
                      <img src={m.url} alt="Customer photo" className="h-20 w-20 rounded-xl object-cover" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
              {can("agent") && r.rating && (
                <div className="mt-3 flex gap-2">
                  {r.status !== "published" && (
                    <Button size="sm" onClick={() => setReview(r.id, "published")}>
                      <Eye className="h-3.5 w-3.5" /> Publish
                    </Button>
                  )}
                  {r.status !== "hidden" && (
                    <Button size="sm" variant="secondary" onClick={() => setReview(r.id, "hidden")}>
                      <EyeOff className="h-3.5 w-3.5" /> Hide
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
