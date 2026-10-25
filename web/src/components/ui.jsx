import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

const cx = (...c) => c.filter(Boolean).join(" ");
export { cx };

export function Button({ variant = "primary", size = "md", className, loading, children, ...props }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-950";
  const sizes = { sm: "px-2.5 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-5 py-2.5 text-sm" };
  const variants = {
    primary: "brand-gradient text-white shadow-glow hover:brightness-110",
    secondary: "bg-white text-gray-800 ring-1 ring-gray-200 shadow-xs hover:bg-gray-50 hover:ring-gray-300 dark:bg-gray-900 dark:text-gray-100 dark:ring-gray-700 dark:hover:bg-gray-800",
    danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
    ghost: "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
  };
  return (
    <button className={cx(base, sizes[size], variants[variant], className)} disabled={loading || props.disabled} {...props}>
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Card({ title, icon: Icon, actions, className, children, padded = true }) {
  return (
    <div className={cx("animate-rise rounded-2xl border border-white/60 bg-white shadow-soft dark:border-gray-800 dark:bg-gray-900/80", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3.5 dark:border-gray-800">
          <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            {Icon && <Icon className="h-4 w-4 text-brand-600" aria-hidden />}
            {title}
          </h3>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </div>
  );
}

const STAT_TONES = {
  gray: { text: "text-gray-900 dark:text-gray-50", chip: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
  green: { text: "text-brand-700 dark:text-brand-400", chip: "bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300" },
  red: { text: "text-red-600 dark:text-red-400", chip: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300" },
  amber: { text: "text-amber-600 dark:text-amber-400", chip: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  blue: { text: "text-sky-600 dark:text-sky-400", chip: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300" },
};

export function Stat({ label, value, sub, tone = "gray", icon: Icon }) {
  const t = STAT_TONES[tone] || STAT_TONES.gray;
  return (
    <div className="animate-rise group relative overflow-hidden rounded-2xl border border-white/60 bg-white p-5 shadow-soft transition hover:-translate-y-0.5 hover:shadow-lift dark:border-gray-800 dark:bg-gray-900/80">
      <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-brand-500/5 transition group-hover:bg-brand-500/10" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        {Icon && (
          <span className={cx("flex h-8 w-8 items-center justify-center rounded-xl", t.chip)}>
            {typeof Icon === "string" ? Icon : <Icon className="h-4 w-4" aria-hidden />}
          </span>
        )}
      </div>
      <div className={cx("mt-2 text-2xl font-bold tracking-tight tabular-nums", t.text)}>{value}</div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function Badge({ tone = "gray", children, className, dot }) {
  const tones = {
    gray: "bg-gray-100 text-gray-700 ring-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700",
    green: "bg-brand-50 text-brand-800 ring-brand-200 dark:bg-brand-900/40 dark:text-brand-300 dark:ring-brand-800",
    red: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-900/40 dark:text-red-300 dark:ring-red-900",
    amber: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:ring-amber-900",
    orange: "bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:ring-orange-900",
    blue: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:ring-sky-900",
    purple: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:ring-violet-900",
  };
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset", tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Spinner({ className = "h-5 w-5" }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }) {
  return <div className={cx("skeleton rounded-lg", className)} aria-hidden />;
}

/** Placeholder page: stat tiles + a card, shimmering while data loads. */
export function Loading({ label = "Loading…" }) {
  return (
    <div className="space-y-4" role="status" aria-label={label}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-white/60 bg-white p-5 shadow-soft dark:border-gray-800 dark:bg-gray-900/80">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-28" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-white/60 bg-white p-5 shadow-soft dark:border-gray-800 dark:bg-gray-900/80">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        {error.message || String(error)}
        {Array.isArray(error.details) && (
          <ul className="mt-1 list-disc pl-5">
            {error.details.map((d, i) => (
              <li key={i}>{typeof d === "string" ? d : JSON.stringify(d)}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Soft illustration used on empty states: a chat bubble over a parcel. */
export function EmptyArt({ className = "h-28 w-36" }) {
  return (
    <svg className={className} viewBox="0 0 180 140" fill="none" aria-hidden>
      <defs>
        <linearGradient id="ea-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#25d366" />
          <stop offset="1" stopColor="#059669" />
        </linearGradient>
      </defs>
      <ellipse cx="90" cy="126" rx="62" ry="8" fill="currentColor" opacity="0.06" />
      <rect x="40" y="58" width="78" height="60" rx="10" fill="currentColor" opacity="0.08" />
      <path d="M40 74h78" stroke="currentColor" opacity="0.15" strokeWidth="2" />
      <rect x="71" y="58" width="16" height="22" fill="currentColor" opacity="0.12" />
      <g transform="translate(86 14)">
        <rect width="72" height="48" rx="16" fill="url(#ea-g)" />
        <path d="M18 48l-4 14 16-14z" fill="#059669" />
        <circle cx="22" cy="24" r="4" fill="white" />
        <circle cx="36" cy="24" r="4" fill="white" opacity="0.85" />
        <circle cx="50" cy="24" r="4" fill="white" opacity="0.7" />
      </g>
      <circle cx="30" cy="34" r="5" fill="#25d366" opacity="0.35" />
      <circle cx="160" cy="92" r="3.5" fill="#059669" opacity="0.35" />
    </svg>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center text-gray-400">
      <EmptyArt />
      <div className="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</div>
      {children && <div className="max-w-md text-sm text-gray-500">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <label className={cx("block", className)}>
      {label && <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-300">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm shadow-xs transition placeholder:text-gray-400 hover:border-gray-300 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15 dark:border-gray-700 dark:bg-gray-900 dark:hover:border-gray-600";

export const Input = ({ className, ...p }) => <input className={cx(inputCls, className)} {...p} />;
export const Textarea = ({ className, ...p }) => <textarea className={cx(inputCls, "min-h-[90px]", className)} {...p} />;
export function Select({ className, options, children, ...p }) {
  return (
    <select className={cx(inputCls, "pr-8", className)} {...p}>
      {options
        ? options.map((o) => (
            <option key={o.value ?? o} value={o.value ?? o}>
              {o.label ?? o}
            </option>
          ))
        : children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition", checked ? "brand-gradient shadow-glow" : "bg-gray-300 dark:bg-gray-700")}
        role="switch"
        aria-checked={checked}
      >
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition", checked ? "left-4.5" : "left-0.5")} />
      </button>
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-gray-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Table({ columns, rows, onRowClick, empty = "Nothing here yet" }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/70 text-left text-[11px] uppercase tracking-wider text-gray-500 dark:border-gray-800 dark:bg-gray-800/30">
            {columns.map((c) => (
              <th key={c.key} className={cx("whitespace-nowrap px-4 py-3 font-semibold", c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-gray-500">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((row, i) => (
            <tr
              key={row.id ?? i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cx("border-b border-gray-50 last:border-0 dark:border-gray-800/60", onRowClick && "cursor-pointer transition-colors hover:bg-brand-50/50 dark:hover:bg-brand-900/10")}
            >
              {columns.map((c) => (
                <td key={c.key} className={cx("px-4 py-3 align-middle", c.className)}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const supportsClosedBy = typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;

/** Native <dialog> opened with showModal(): focus trap, Esc and backdrop light-dismiss, animated in and out. */
export function Modal({ open, onClose, title, children, footer, wide }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    // Esc / closedby light-dismiss: play the exit animation, then let the parent unmount us.
    const onCancel = (e) => {
      e.preventDefault();
      requestClose();
    };
    const onClick = (e) => {
      if (supportsClosedBy || e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = r.top <= e.clientY && e.clientY <= r.bottom && r.left <= e.clientX && e.clientX <= r.right;
      if (!inside) requestClose();
    };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("click", onClick);
    };
  }, [open]);

  async function requestClose() {
    const dialog = ref.current;
    if (!dialog || dialog.hasAttribute("data-closing")) return;
    dialog.setAttribute("data-closing", "");
    const anims = dialog.getAnimations({ subtree: true });
    await Promise.race([Promise.allSettled(anims.map((a) => a.finished)), new Promise((r) => setTimeout(r, 260))]);
    closeRef.current?.();
  }

  if (!open) return null;
  return (
    <dialog ref={ref} closedby="any" aria-labelledby="modal-title" className={cx("modal w-[calc(100%-2rem)] text-gray-900 dark:text-gray-100", wide ? "max-w-3xl" : "max-w-lg")}>
      <div className="flex max-h-[86vh] flex-col overflow-hidden rounded-2xl border border-white/60 bg-white shadow-lift dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <h3 id="modal-title" className="font-semibold tracking-tight">
            {title}
          </h3>
          <button onClick={requestClose} className="rounded-lg p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50/60 px-5 py-3 dark:border-gray-800 dark:bg-gray-900">{footer}</div>}
      </div>
    </dialog>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-gray-100 p-1 dark:bg-gray-800/70" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition",
            value === t.value ? "bg-white text-brand-700 shadow-sm dark:bg-gray-900 dark:text-brand-400" : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-gray-200/80 px-1.5 text-xs dark:bg-gray-700">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, icon: Icon }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        {Icon && (
          <span className="brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-white shadow-glow">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
        )}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, tone = "green") => {
    const id = Math.random();
    setItems((x) => [...x, { id, message: typeof message === "string" ? message : message?.message || "Done", tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="animate-rise flex max-w-sm items-start gap-2.5 rounded-xl bg-navy-900/95 px-4 py-3 text-sm text-white shadow-lift ring-1 ring-white/10 backdrop-blur">
            {t.tone === "red" ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-400" />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action with loading state and toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn, success) => {
      setBusy(true);
      try {
        const out = await fn();
        if (success) toast(success);
        return out;
      } catch (e) {
        toast(e.details?.length ? `${e.message}: ${e.details.map((d) => (typeof d === "string" ? d : d.error || JSON.stringify(d))).join("; ")}` : e.message, "red");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );
  return [run, busy];
}
