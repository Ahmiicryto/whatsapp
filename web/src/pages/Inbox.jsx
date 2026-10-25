import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi, post, patch, qs } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { ago, money, STATUS_LABEL, STATUS_TONE } from "../lib/format.js";
import { Badge, Button, Input, Select, Textarea, Loading, Empty, useAction, cx } from "../components/ui.jsx";
import { MessageTimeline } from "./OrderDetail.jsx";

function Composer({ conv, templates, onSent }) {
  const [text, setText] = useState("");
  const [tplId, setTplId] = useState("");
  const [run, busy] = useAction();
  const [suggesting, setSuggesting] = useState(false);

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
    <div className="border-t border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
      {!conv.window_open && (
        <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          The 24-hour window is closed. WhatsApp only allows approved templates until the customer replies.
        </div>
      )}
      {conv.window_open && !tplId ? (
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a reply… (AI replies pause for this chat while you take over)"
          className="min-h-[70px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
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
          <Button variant="ghost" onClick={suggest} loading={suggesting}>
            ✨ Suggest reply
          </Button>
        )}
        <Button className="ml-auto" onClick={send} loading={busy} disabled={!conv.window_open && !tplId}>
          Send
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
        <div className="hidden w-64 shrink-0 overflow-y-auto border-l border-gray-200 bg-white p-3 text-sm dark:border-gray-800 dark:bg-gray-900 xl:block">
          <div className="mb-2 text-xs font-medium uppercase text-gray-500">Orders</div>
          {data.orders.length === 0 && <div className="text-gray-500">No orders</div>}
          {data.orders.map((o) => (
            <Link key={o.id} to={`/orders/${o.id}`} className="mb-2 block rounded-lg border border-gray-100 p-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800">
              <div className="flex justify-between font-medium">
                {o.name} <span>{money(o.total, o.currency)}</span>
              </div>
              <Badge tone={STATUS_TONE[o.status]}>{STATUS_LABEL[o.status]}</Badge>
            </Link>
          ))}
          {data.customer && (
            <div className="mt-4 text-xs text-gray-500">
              {data.customer.orders_count} orders · {data.customer.wa_opt_in ? "opted in to offers" : "not opted in"}
              {data.customer.rfm_segment && ` · ${data.customer.rfm_segment}`}
            </div>
          )}
        </div>
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
    <div className="-m-4 flex h-[calc(100vh-0px)] overflow-hidden lg:-m-6">
      <div className={cx("flex w-full flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 md:w-80", id && "hidden md:flex")}>
        <div className="space-y-2 border-b border-gray-200 p-3 dark:border-gray-800">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <Input placeholder="Search name, number, message" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <div className="flex gap-2">
            <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "", label: "All" }]} />
            <Select value={filter.needsHuman} onChange={(e) => setFilter({ ...filter, needsHuman: e.target.value })} options={[{ value: "", label: "Everyone" }, { value: "1", label: "Needs human" }]} />
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
              {storeId === "all" && <div className="text-[11px] text-gray-400">{c.store_name}</div>}
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
