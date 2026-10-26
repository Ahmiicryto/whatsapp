import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi, post, patch, del, qs } from "../lib/api.js";
import { Bookmark, SendHorizontal, ShoppingBag, Sparkles, StickyNote } from "lucide-react";
import { useSession } from "../lib/session.jsx";
import { ago, money, STATUS_LABEL, STATUS_TONE } from "../lib/format.js";
import { Badge, Button, Input, Modal, Select, Textarea, Loading, Empty, useAction, cx } from "../components/ui.jsx";
import { MessageTimeline } from "./OrderDetail.jsx";

function SavedRepliesModal({ onClose, onPick }) {
  const list = useApi("/saved-replies");
  const [f, setF] = useState({ title: "", shortcut: "", body: "" });
  const [run, busy] = useAction();
  return (
    <Modal open wide onClose={onClose} title="Saved replies">
      <div className="grid gap-4 md:grid-cols-2">
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {list.data?.length === 0 && <li className="text-sm text-gray-500">No saved replies yet.</li>}
          {list.data?.map((r) => (
            <li key={r.id} className="group flex items-start gap-2 rounded-xl p-2 hover:bg-gray-50 dark:hover:bg-gray-800/50">
              <button className="min-w-0 flex-1 text-left" onClick={() => (onPick(r.body), onClose())}>
                <div className="text-sm font-semibold">
                  {r.title} {r.shortcut && <span className="font-mono text-xs text-gray-400">/{r.shortcut}</span>}
                </div>
                <div className="line-clamp-2 text-xs text-gray-500">{r.body}</div>
              </button>
              <button className="text-xs text-gray-400 opacity-0 hover:text-red-600 group-hover:opacity-100" onClick={() => run(() => del(`/saved-replies/${r.id}`)).then(list.reload)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="space-y-2">
          <Input placeholder="Title, e.g. Delivery time" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <Input placeholder="Shortcut, e.g. dt (type /dt)" value={f.shortcut} onChange={(e) => setF({ ...f, shortcut: e.target.value.replace(/\s/g, "") })} />
          <Textarea placeholder="Message text" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          <Button loading={busy} disabled={!f.title || !f.body} onClick={() => run(() => post("/saved-replies", f), "Saved").then(() => (setF({ title: "", shortcut: "", body: "" }), list.reload()))}>
            Add saved reply
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProductPicker({ conv, onClose, onSent }) {
  const [q, setQ] = useState("");
  const list = useApi(`/products${qs({ storeId: conv.store_id, q, limit: 24 })}`);
  const [run, busy] = useAction();
  return (
    <Modal open wide onClose={onClose} title="Send a product">
      <Input placeholder="Search products" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {list.data?.rows.map((p) => (
          <button
            key={p.id}
            disabled={busy}
            onClick={() => run(() => post(`/conversations/${conv.id}/send-product`, { productId: p.id }), "Product sent").then((r) => r && (onSent(), onClose()))}
            className="overflow-hidden rounded-xl text-left ring-1 ring-gray-200 transition hover:ring-brand-500 dark:ring-gray-700"
          >
            {p.image_url ? <img src={p.image_url} alt="" className="aspect-square w-full object-cover" loading="lazy" /> : <div className="aspect-square bg-gray-100 dark:bg-gray-800" />}
            <div className="p-2">
              <div className="line-clamp-2 text-xs font-semibold">{p.title}</div>
              <div className="text-xs text-brand-700 dark:text-brand-400">{money(p.price_min, p.currency || undefined)}</div>
            </div>
          </button>
        ))}
      </div>
      {list.data?.rows.length === 0 && <p className="text-sm text-gray-500">No products. Sync them on the Products page.</p>}
    </Modal>
  );
}

function Composer({ conv, templates, onSent }) {
  const [text, setText] = useState("");
  const [tplId, setTplId] = useState("");
  const [run, busy] = useAction();
  const [suggesting, setSuggesting] = useState(false);
  const [modal, setModal] = useState(null);
  const saved = useApi("/saved-replies");
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const matches = slash !== null ? (saved.data || []).filter((r) => (r.shortcut || "").toLowerCase().startsWith(slash) || r.title.toLowerCase().includes(slash)).slice(0, 6) : [];

  async function send() {
    const body = tplId ? { templateId: Number(tplId) } : { text };
    if (!tplId && !text.trim()) return;
    const ok = await run(() => post(`/conversations/${conv.id}/send`, body), "Sent");
    if (ok) {
      setText("");
      setTplId("");
      onSent();
    }
  }

  async function suggest() {
    setSuggesting(true);
    try {
      const r = await post(`/conversations/${conv.id}/suggest`);
      setText(r.suggestion);
    } catch (e) {
      setText(`(${e.message})`);
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="relative border-t border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      {!conv.window_open && (
        <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          The 24-hour window is closed. WhatsApp only allows approved templates until the customer replies.
        </div>
      )}
      {matches.length > 0 && (
        <ul className="animate-rise absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-xl border border-gray-100 bg-white shadow-lift dark:border-gray-800 dark:bg-gray-900">
          {matches.map((r) => (
            <li key={r.id}>
              <button className="block w-full px-3 py-2 text-left text-sm hover:bg-brand-50 dark:hover:bg-brand-900/20" onClick={() => setText(r.body)}>
                <span className="font-semibold">{r.title}</span> <span className="text-xs text-gray-500">{r.body.slice(0, 80)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {conv.window_open && !tplId ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a reply… type / for saved replies. AI pauses for this chat while you take over."
          className="min-h-[70px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            if (e.key === "Tab" && matches[0]) {
              e.preventDefault();
              setText(matches[0].body);
            }
          }}
        />
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select value={tplId} onChange={(e) => setTplId(e.target.value)} className="w-auto max-w-xs">
          <option value="">{conv.window_open ? "Free text" : "Choose a template…"}</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.category.toLowerCase()})
            </option>
          ))}
        </Select>
        {conv.window_open && !tplId && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setModal("saved")} title="Saved replies">
              <Bookmark className="h-4 w-4" /> Saved
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setModal("product")} title="Send a product">
              <ShoppingBag className="h-4 w-4" /> Product
            </Button>
            <Button variant="ghost" size="sm" onClick={suggest} loading={suggesting}>
              <Sparkles className="h-4 w-4" /> Suggest
            </Button>
          </>
        )}
        <Button className="ml-auto" onClick={send} loading={busy} disabled={!conv.window_open && !tplId}>
          <SendHorizontal className="h-4 w-4" /> Send
        </Button>
      </div>
      {modal === "saved" && <SavedRepliesModal onClose={() => setModal(null)} onPick={setText} />}
      {modal === "product" && <ProductPicker conv={conv} onClose={() => setModal(null)} onSent={onSent} />}
    </div>
  );
}

function SidePanel({ data, conv, onUpdate }) {
  const team = useApi("/team/directory");
  const notes = useApi(`/conversations/${conv.id}/notes`);
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");
  const [run, busy] = useAction();
  return (
    <div className="hidden w-72 shrink-0 space-y-5 overflow-y-auto border-l border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-900 xl:block">
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400">Assigned to</div>
        <Select value={conv.assigned_user_id || ""} onChange={(e) => onUpdate({ assigned_user_id: e.target.value ? Number(e.target.value) : null }, "Assigned")}>
          <option value="">Nobody</option>
          {team.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400">Labels</div>
        <div className="flex flex-wrap gap-1">
          {(conv.labels || []).map((l) => (
            <button key={l} onClick={() => onUpdate({ labels: conv.labels.filter((x) => x !== l) })} title="Remove">
              <Badge tone="purple">{l} ×</Badge>
            </button>
          ))}
        </div>
        <form
          className="mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) onUpdate({ labels: [...(conv.labels || []), label.trim()] }).then(() => setLabel(""));
          }}
        >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add label (VIP, Complaint…)" />
        </form>
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400">Orders</div>
        {data.orders.length === 0 && <div className="text-gray-500">No orders</div>}
        {data.orders.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="mb-2 block rounded-xl border border-gray-100 p-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800">
            <div className="flex justify-between font-medium">
              {o.name} <span>{money(o.total, o.currency)}</span>
            </div>
            <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
          </Link>
        ))}
        {data.customer && (
          <div className="mt-2 text-xs text-gray-500">
            {data.customer.orders_count} orders · {data.customer.wa_opt_in ? "opted in to offers" : "not opted in"}
            {data.customer.rfm_segment && ` · ${data.customer.rfm_segment}`}
          </div>
        )}
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-400">
          <StickyNote className="h-3.5 w-3.5" /> Internal notes
        </div>
        <ul className="space-y-2">
          {notes.data?.map((n) => (
            <li key={n.id} className="rounded-xl bg-amber-50 p-2 text-xs text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="whitespace-pre-wrap">{n.body}</div>
              <div className="mt-1 text-[10px] opacity-60">
                {n.user_name || n.user_email} · {ago(n.created_at)}
              </div>
            </li>
          ))}
        </ul>
        <Textarea className="mt-2 min-h-[60px] text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only your team sees this. @email mentions a teammate." />
        <Button size="sm" className="mt-1" variant="secondary" loading={busy} disabled={!note.trim()} onClick={() => run(() => post(`/conversations/${conv.id}/notes`, { body: note })).then(() => (setNote(""), notes.reload()))}>
          Add note
        </Button>
      </div>
    </div>
  );
}

function Conversation({ id, onChange }) {
  const { data, reload } = useApi(`/conversations/${id}`, { interval: 8000 });
  const bottom = useRef(null);
  const [run] = useAction();
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [data?.messages?.length]);
  useEffect(() => {
    if (data?.conversation?.unread) patch(`/conversations/${id}`, { unread: 0 }).then(onChange).catch(() => {});
  }, [data?.conversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Loading />;
  const c = data.conversation;
  const update = (body, msg) => run(() => patch(`/conversations/${id}`, body), msg).then(() => {
    reload();
    onChange();
  });
  const aiPaused = c.ai_paused_until && new Date(c.ai_paused_until) > new Date();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{c.name || c.phone_e164}</div>
          <div className="text-xs text-gray-500">
            {c.phone_e164} · {c.window_open ? "🟢 window open" : "⚪ window closed"}
          </div>
        </div>
        {c.needs_human && <Badge tone="red">Needs human</Badge>}
        <Button size="sm" variant="secondary" onClick={() => update({ ai_paused: !aiPaused }, aiPaused ? "AI resumed" : "AI paused")}>
          {aiPaused ? "Resume AI" : "Pause AI"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => update({ status: c.status === "open" ? "resolved" : "open", needs_human: false }, "Updated")}>
          {c.status === "open" ? "Resolve" : "Reopen"}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="wa-chat-bg min-h-0 flex-1 overflow-y-auto p-4">
          <MessageTimeline messages={data.messages} />
          <div ref={bottom} />
        </div>
        <SidePanel data={data} conv={c} onUpdate={(body, msg) => update(body, msg)} />
      </div>
      <Composer conv={c} templates={data.templates} onSent={reload} />
    </div>
  );
}

export default function Inbox() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { storeId } = useSession();
  const [filter, setFilter] = useState({ q: "", needsHuman: "", status: "open" });
  const list = useApi(`/conversations${qs({ storeId, ...filter })}`, { interval: 10000 });

  return (
    <div className="-m-4 flex h-[calc(100dvh-57px)] overflow-hidden lg:-m-8">
      <div className={cx("flex w-full flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 md:w-80", id && "hidden md:flex")}>
        <div className="space-y-2 border-b border-gray-200 p-3 dark:border-gray-800">
          <h1 className="text-lg font-bold tracking-tight">Inbox</h1>
          <Input placeholder="Search name, number, message" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <div className="grid grid-cols-3 gap-1.5 [&_select]:px-2 [&_select]:text-xs">
            <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "", label: "All" }]} />
            <Select value={filter.needsHuman} onChange={(e) => setFilter({ ...filter, needsHuman: e.target.value })} options={[{ value: "", label: "Everyone" }, { value: "1", label: "Needs me" }]} aria-label="Needs a person" />
            <Select value={filter.assigned || ""} onChange={(e) => setFilter({ ...filter, assigned: e.target.value })} options={[{ value: "", label: "Anyone" }, { value: "me", label: "Mine" }]} aria-label="Assigned" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!list.data && <Loading />}
          {list.data?.length === 0 && <Empty title="No conversations">Messages from customers appear here.</Empty>}
          {list.data?.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/inbox/${c.id}`)}
              className={cx("block w-full border-b border-gray-50 px-3 py-2.5 text-left hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50", String(c.id) === id && "bg-brand-50 dark:bg-brand-700/20")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{c.name || c.phone_e164}</span>
                <span className="shrink-0 text-[11px] text-gray-500">{ago(c.last_message_at)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="truncate text-xs text-gray-500">{c.last_message_preview}</span>
                {c.needs_human && <span className="shrink-0 text-xs">🙋</span>}
                {c.unread > 0 && <span className="ml-auto shrink-0 rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{c.unread}</span>}
              </div>
              {(c.labels?.length > 0 || storeId === "all" || c.assigned_name) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-gray-400">
                  {storeId === "all" && <span>{c.store_name}</span>}
                  {c.assigned_name && <span>→ {c.assigned_name}</span>}
                  {c.labels?.map((l) => (
                    <span key={l} className="rounded-full bg-violet-100 px-1.5 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                      {l}
                    </span>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className={cx("min-w-0 flex-1", !id && "hidden md:block")}>
        {id ? (
          <div className="flex h-full flex-col">
            <button onClick={() => navigate("/inbox")} className="border-b border-gray-200 px-4 py-2 text-left text-sm text-gray-500 dark:border-gray-800 md:hidden">
              ← All chats
            </button>
            <div className="min-h-0 flex-1">
              <Conversation key={id} id={id} onChange={list.reload} />
            </div>
          </div>
        ) : (
          <Empty title="Select a conversation">AI handles routine questions; chats flagged 🙋 need a person.</Empty>
        )}
      </div>
    </div>
  );
}
