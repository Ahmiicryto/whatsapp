import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Boxes, CornerDownLeft, FileText, MessageCircle, Package, Search, Store, Truck, User, Zap } from "lucide-react";
import { get } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { Modal, Spinner, cx } from "./ui.jsx";

const TYPE_ICON = { order: Package, customer: User, chat: MessageCircle, product: Boxes, shipment: Truck, store: Store, page: FileText, action: Zap };

/** Pages and shortcuts found without a server call. */
export const PAGES = [
  { title: "Dashboard", link: "/", keywords: "home overview stats" },
  { title: "Orders", link: "/orders", keywords: "orders cod confirm" },
  { title: "Orders needing attention", link: "/orders?filter=attention", keywords: "risk problem attention" },
  { title: "Shipments & COD", link: "/shipments", keywords: "courier tracking cod cash settlement postex leopards trax" },
  { title: "Inbox", link: "/inbox", keywords: "chat messages whatsapp" },
  { title: "Customers", link: "/customers", keywords: "people buyers" },
  { title: "Products", link: "/products", keywords: "catalog images stock" },
  { title: "Reviews", link: "/reviews", keywords: "ratings photos feedback" },
  { title: "Marketing campaigns", link: "/marketing", keywords: "broadcast campaign offers" },
  { title: "Templates", link: "/templates", keywords: "meta message templates" },
  { title: "Automations", link: "/automations", keywords: "settings reminders" },
  { title: "Automation rules (flows)", link: "/flows", keywords: "if then rules workflow flow builder" },
  { title: "Fraud protection", link: "/fraud", keywords: "blocklist fake orders risk advance payment" },
  { title: "Profit", link: "/profit", keywords: "profit cost roas ad spend margin" },
  { title: "Reports", link: "/reports", keywords: "pdf daily weekly" },
  { title: "Stores", link: "/stores", keywords: "shopify connect" },
  { title: "Team & logs", link: "/team", keywords: "users roles audit" },
  { title: "Billing & plan", link: "/billing", keywords: "subscription upgrade invoice usage" },
  { title: "Developers (API & webhooks)", link: "/developers", keywords: "api token webhook integration zapier" },
  { title: "My profile", link: "/profile", keywords: "password number daily report notifications" },
  { title: "Help center", link: "/help", keywords: "guide how to docs support" },
];
const ACTIONS = [
  { title: "Create a campaign", link: "/marketing?new=1", keywords: "new broadcast" },
  { title: "Connect a store", link: "/stores?connect=1", keywords: "add shopify" },
  { title: "Book pending shipments", link: "/shipments?tab=to_book", keywords: "courier book" },
  { title: "Add a rule", link: "/flows?new=1", keywords: "automation" },
];

const RECENT_KEY = "wa.recentSearch";
const readRecent = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
};

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const { storeId } = useSession();
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setRemote([]);
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) return setRemote([]);
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await get(`/search?q=${encodeURIComponent(q.trim())}&storeId=${storeId}`);
        setRemote(r.results);
      } catch {
        setRemote([]);
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(t);
  }, [q, storeId]);

  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const match = (x) => !t || `${x.title} ${x.keywords}`.toLowerCase().includes(t);
    const local = [...PAGES.filter(match).map((p) => ({ ...p, type: "page" })), ...ACTIONS.filter(match).map((a) => ({ ...a, type: "action" }))];
    if (!t) return [...readRecent().map((r) => ({ ...r, recent: true })), ...local.slice(0, 8)];
    return [...remote, ...local.slice(0, 6)];
  }, [q, remote]);

  useEffect(() => setActive(0), [items.length]);

  function go(item) {
    if (!item) return;
    if (item.type !== "page" && item.type !== "action") {
      const recent = [{ type: item.type, title: item.title, sub: item.sub, link: item.link }, ...readRecent().filter((r) => r.link !== item.link)].slice(0, 5);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {
        /* private mode */
      }
    }
    onClose();
    navigate(item.link);
  }

  function onKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[active]);
    }
  }

  return (
    <Modal open={open} onClose={onClose} bare title="Search" className="palette w-[calc(100%-2rem)] max-w-xl">
      {() => (
        <div className="overflow-hidden rounded-2xl border border-white/60 bg-white shadow-lift dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center gap-3 border-b border-gray-100 px-4 dark:border-gray-800">
            {loading ? <Spinner className="h-4 w-4 text-gray-400" /> : <Search className="h-4 w-4 text-gray-400" />}
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
              placeholder="Search orders, phone numbers, customers, products, tracking numbers…"
              className="h-14 flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={items[active] ? `pal-${active}` : undefined}
            />
            <kbd className="hidden rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 sm:block dark:bg-gray-800">ESC</kbd>
          </div>
          <ul id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
            {items.length === 0 && <li className="px-3 py-8 text-center text-sm text-gray-500">{q.length < 2 ? "Type to search" : "No matches"}</li>}
            {items.map((it, i) => {
              const Icon = TYPE_ICON[it.type] || FileText;
              const showHeader = i === 0 || items[i - 1].type !== it.type || items[i - 1].recent !== it.recent;
              return (
                <li key={`${it.type}-${it.id ?? it.link}-${i}`}>
                  {showHeader && (
                    <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                      {it.recent ? "Recent" : { order: "Orders", customer: "Customers", chat: "Chats", product: "Products", shipment: "Shipments", store: "Stores", page: "Pages", action: "Actions" }[it.type]}
                    </div>
                  )}
                  <button
                    id={`pal-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(it)}
                    className={cx("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm", i === active ? "bg-brand-50 text-brand-900 dark:bg-brand-900/30 dark:text-brand-100" : "")}
                  >
                    {it.image ? (
                      <img src={it.image} alt="" className="h-8 w-8 rounded-lg object-cover" />
                    ) : (
                      <span className={cx("flex h-8 w-8 items-center justify-center rounded-lg", i === active ? "bg-white text-brand-600 dark:bg-gray-900" : "bg-gray-100 text-gray-500 dark:bg-gray-800")}>
                        <Icon className="h-4 w-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{it.title}</span>
                      {it.sub && <span className="block truncate text-xs text-gray-500">{it.sub}</span>}
                    </span>
                    {i === active ? <CornerDownLeft className="h-4 w-4 text-brand-600" /> : <ArrowRight className="h-4 w-4 text-gray-300" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="flex gap-4 border-t border-gray-100 px-4 py-2 text-[11px] text-gray-400 dark:border-gray-800">
            <span>↑↓ to move</span>
            <span>↵ to open</span>
            <span>Tip: search a phone number or tracking number</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
