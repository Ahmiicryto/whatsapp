import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bell, BellRing, CheckCheck, CheckCircle2, Info, XCircle } from "lucide-react";
import { get, post } from "../lib/api.js";
import { ago } from "../lib/format.js";
import { cx } from "./ui.jsx";

const SEV = {
  info: { icon: Info, cls: "bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-300" },
  success: { icon: CheckCircle2, cls: "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300" },
  warning: { icon: AlertTriangle, cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  danger: { icon: XCircle, cls: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300" },
};

const canNotify = () => typeof Notification !== "undefined";

/** Bell with unread count, polling every 30s; optionally mirrors new items as desktop notifications. */
export default function NotificationBell({ dark }) {
  const [data, setData] = useState({ rows: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState(canNotify() ? Notification.permission : "denied");
  const seen = useRef(null);
  const box = useRef(null);
  const navigate = useNavigate();

  async function load() {
    try {
      const d = await get("/notifications");
      setData(d);
      const newest = d.rows[0]?.id || 0;
      if (seen.current !== null && newest > seen.current && perm === "granted" && document.hidden) {
        for (const n of d.rows.filter((r) => r.id > seen.current && !r.read).slice(0, 3)) {
          const desk = new Notification(n.title, { body: n.body || "", tag: `wa-${n.id}` });
          desk.onclick = () => {
            window.focus();
            if (n.link) navigate(n.link);
          };
        }
      }
      seen.current = newest;
    } catch {
      /* offline or signed out */
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [perm]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function readAll() {
    await post("/notifications/read", {});
    load();
  }
  async function openItem(n) {
    if (!n.read) post("/notifications/read", { ids: [n.id] }).then(load);
    setOpen(false);
    if (n.link) navigate(n.link);
  }

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen(!open)}
        className={cx("relative rounded-xl p-2 transition", dark ? "text-slate-300 hover:bg-white/10" : "text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800")}
        aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ""}`}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {data.unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white ring-2 ring-white dark:ring-gray-900">
            {data.unread > 99 ? "99+" : data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="animate-rise absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/60 bg-white text-gray-900 shadow-lift dark:border-gray-800 dark:bg-gray-900 dark:text-gray-100">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
            <span className="text-sm font-semibold">Notifications</span>
            <button onClick={readAll} className="flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline dark:text-brand-400">
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          </div>
          <ul className="max-h-[60vh] divide-y divide-gray-50 overflow-y-auto dark:divide-gray-800">
            {data.rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-gray-500">You're all caught up 🎉</li>}
            {data.rows.map((n) => {
              const s = SEV[n.severity] || SEV.info;
              return (
                <li key={n.id}>
                  <button onClick={() => openItem(n)} className={cx("flex w-full gap-3 px-4 py-3 text-left transition hover:bg-gray-50 dark:hover:bg-gray-800/50", !n.read && "bg-brand-50/40 dark:bg-brand-900/10")}>
                    <span className={cx("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", s.cls)}>
                      <s.icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className={cx("text-sm", !n.read && "font-semibold")}>{n.title}</span>
                        {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" />}
                      </span>
                      {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-gray-500">{n.body}</span>}
                      <span className="mt-1 block text-[11px] text-gray-400">{ago(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {canNotify() && perm !== "granted" && perm !== "denied" && (
            <button
              onClick={async () => setPerm(await Notification.requestPermission())}
              className="flex w-full items-center justify-center gap-2 border-t border-gray-100 px-4 py-2.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800/50"
            >
              <BellRing className="h-3.5 w-3.5" /> Turn on desktop alerts
            </button>
          )}
        </div>
      )}
    </div>
  );
}
