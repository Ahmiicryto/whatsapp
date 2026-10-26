import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../lib/session.jsx";
import { post } from "../lib/api.js";
import {
  BarChart3,
  Boxes,
  CircleHelp,
  Code2,
  CreditCard,
  LifeBuoy,
  Search,
  ShieldAlert,
  Star,
  TrendingUp,
  Truck,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  MessageCircle,
  Package,
  Puzzle,
  ShieldCheck,
  Store,
  UserCircle2,
  Users,
  UsersRound,
  Workflow,
} from "lucide-react";
import { cx, Select } from "./ui.jsx";
import CommandPalette from "./CommandPalette.jsx";
import NotificationBell from "./Notifications.jsx";
import HelpDrawer from "./HelpDrawer.jsx";
import { guideForPath } from "../lib/guides.js";

const NAV = [
  { section: "Overview" },
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/orders", label: "Orders", icon: Package },
  { to: "/shipments", label: "Shipments & COD", icon: Truck },
  { to: "/inbox", label: "Inbox", icon: MessageCircle },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/products", label: "Products", icon: Boxes },
  { to: "/reviews", label: "Reviews", icon: Star },
  { section: "Grow", min: "admin" },
  { to: "/marketing", label: "Marketing", icon: Megaphone, min: "admin" },
  { to: "/templates", label: "Templates", icon: Puzzle, min: "admin" },
  { to: "/automations", label: "Automations", icon: Workflow, min: "admin" },
  { to: "/flows", label: "Automation rules", icon: GitBranch, min: "admin" },
  { section: "Insights" },
  { to: "/profit", label: "Profit", icon: TrendingUp, min: "admin" },
  { to: "/fraud", label: "Fraud protection", icon: ShieldAlert, min: "agent" },
  { to: "/reports", label: "Reports", icon: BarChart3 },
  { section: "Manage" },
  { to: "/stores", label: "Stores", icon: Store },
  { to: "/team", label: "Team & logs", icon: UsersRound, min: "admin" },
  { to: "/billing", label: "Billing & plan", icon: CreditCard, min: "owner" },
  { to: "/developers", label: "Developers", icon: Code2, min: "admin" },
  { to: "/profile", label: "My profile", icon: UserCircle2 },
  { to: "/help", label: "Help center", icon: LifeBuoy },
];

export function Logo({ className = "h-9 w-9" }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden>
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#25d366" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#logo-g)" />
      <path d="M20 9.5a10.5 10.5 0 0 0-9 15.9L9.6 30.5l5.3-1.4A10.5 10.5 0 1 0 20 9.5z" fill="white" />
      <path d="M15.2 20.3l3.1 3.1 6.6-6.6" stroke="#059669" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Layout() {
  const { me, stores, storeId, setStoreId, can, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [help, setHelp] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Ctrl/⌘ + K opens global search from anywhere; "?" opens this page's guide.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") && !document.activeElement?.isContentEditable) {
        setHelp(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function logout() {
    await post("/auth/logout");
    await refresh();
    navigate("/login");
  }

  async function switchAccount(id) {
    await post("/auth/switch-account", { accountId: Number(id) });
    setStoreId("all");
    await refresh();
    navigate("/");
  }

  async function stopImpersonating() {
    await post("/auth/stop-impersonating");
    await refresh();
    navigate("/admin");
  }

  const linkCls = ({ isActive }) =>
    cx(
      "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition",
      isActive ? "bg-white/10 text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-slate-400 hover:bg-white/5 hover:text-white"
    );
  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV.filter((n) => !n.min || can(n.min)).map((n) =>
        n.section ? (
          <div key={n.section} className="mb-1 mt-4 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 first:mt-0">
            {n.section}
          </div>
        ) : (
          <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)} className={linkCls}>
            {({ isActive }) => (
              <>
                {isActive && <span className="brand-gradient absolute inset-y-1.5 left-0 w-1 rounded-full" />}
                <n.icon className={cx("h-[18px] w-[18px] shrink-0", isActive ? "text-brand-400" : "text-slate-500 group-hover:text-slate-300")} aria-hidden />
                {n.label}
              </>
            )}
          </NavLink>
        )
      )}
      {me?.user?.isSuperAdmin && (
        <NavLink
          to="/admin"
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx("mt-4 flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium ring-1 transition", isActive ? "bg-violet-500/20 text-violet-200 ring-violet-400/30" : "text-violet-300 ring-violet-400/15 hover:bg-violet-500/10")
          }
        >
          <ShieldCheck className="h-[18px] w-[18px]" aria-hidden />
          Super admin
        </NavLink>
      )}
    </nav>
  );

  const initials = (me?.user?.name || me?.user?.email || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const dark = "border-white/10 bg-white/5 text-slate-100 hover:border-white/20 focus:border-brand-400 dark:border-white/10 dark:bg-white/5 [&>option]:text-gray-900";

  return (
    <div className="flex min-h-full">
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-40 flex w-68 transform flex-col bg-navy-950 text-white transition duration-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        style={{ backgroundImage: "radial-gradient(28rem 18rem at 0% 0%, rgb(37 211 102 / 0.16), transparent 60%), radial-gradient(20rem 16rem at 100% 100%, rgb(5 150 105 / 0.14), transparent 60%)" }}
      >
        <div className="flex items-center gap-3 px-5 pb-4 pt-5">
          <Logo />
          <div>
            <div className="text-[15px] font-bold leading-tight tracking-tight">WA Commerce</div>
            <div className="text-xs text-slate-400">Shopify × WhatsApp</div>
          </div>
        </div>
        <div className="space-y-2 px-4 pb-3">
          {me?.accounts?.length > 1 && (
            <Select className={dark} value={me.accountId || ""} onChange={(e) => switchAccount(e.target.value)} aria-label="Business">
              {me.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.viaSuperAdmin ? " (admin view)" : ""}
                </option>
              ))}
            </Select>
          )}
          <Select className={dark} value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label="Store">
            <option value="all">All stores ({stores.length})</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">{nav}</div>
        <div className="m-3 flex items-center gap-3 rounded-2xl bg-white/5 p-3 ring-1 ring-white/10">
          <div className="brand-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold">{initials}</div>
          <div className="min-w-0 flex-1 text-xs">
            <div className="truncate font-semibold text-white">{me?.user?.name || me?.user?.email}</div>
            <div className="truncate capitalize text-slate-400">{me?.user?.isSuperAdmin ? "Super admin" : me?.role}</div>
          </div>
          <button onClick={logout} className="rounded-lg p-2 text-slate-400 transition hover:bg-white/10 hover:text-white" aria-label="Sign out" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-navy-950/50 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {me?.billing && (!me.billing.active || me.billing.status === "trialing") && (
          <div className={cx("flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm", me.billing.active ? "bg-sky-600 text-white" : "bg-red-600 text-white")}>
            <span>
              {me.billing.active
                ? `Free trial${me.billing.trialEndsAt ? ` until ${new Date(me.billing.trialEndsAt).toLocaleDateString()}` : ""}. Choose a plan to keep your automations running.`
                : me.billing.reason}
            </span>
            <NavLink to="/billing" className="rounded-lg bg-white/20 px-2 py-1 font-semibold hover:bg-white/30">
              See plans
            </NavLink>
          </div>
        )}
        {me?.impersonating && (
          <div className="flex items-center justify-between bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 py-2 text-sm text-white">
            <span>You are viewing the portal as {me.user.email}. Actions are logged.</span>
            <button onClick={stopImpersonating} className="rounded-lg bg-white/20 px-2 py-1 hover:bg-white/30">
              Stop impersonating
            </button>
          </div>
        )}
        <header className="glass sticky top-0 z-20 flex items-center gap-2 border-b border-gray-200/70 px-4 py-2.5 lg:px-8 dark:border-gray-800">
          <button onClick={() => setOpen(true)} className="rounded-lg p-1.5 hover:bg-gray-100 lg:hidden dark:hover:bg-gray-800" aria-label="Menu">
            <Menu className="h-5 w-5" />
          </button>
          <Logo className="h-7 w-7 lg:hidden" />
          <button
            onClick={() => setSearching(true)}
            className="ml-auto flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-gray-500 ring-1 ring-gray-200 transition hover:bg-white hover:ring-gray-300 lg:ml-0 lg:w-96 dark:ring-gray-700 dark:hover:bg-gray-900"
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
            <span className="hidden flex-1 text-left sm:inline">Search orders, phones, tracking…</span>
            <kbd className="hidden rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 sm:inline dark:bg-gray-800">Ctrl K</kbd>
          </button>
          <div className="flex items-center gap-1 lg:ml-auto">
            <button onClick={() => setHelp(true)} className="rounded-xl p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800" aria-label="How to use this page" title="How to use this page (?)">
              <CircleHelp className="h-5 w-5" />
            </button>
            <NotificationBell />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
        <CommandPalette open={searching} onClose={() => setSearching(false)} />
        {help && <HelpDrawer guide={guideForPath(location.pathname)} onClose={() => setHelp(false)} />}
      </div>
    </div>
  );
}
