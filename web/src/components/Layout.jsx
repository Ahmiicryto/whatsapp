import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useSession } from "../lib/session.jsx";
import { post } from "../lib/api.js";
import { cx, Select } from "./ui.jsx";

const NAV = [
  { to: "/", label: "Dashboard", icon: "📊", end: true },
  { to: "/orders", label: "Orders", icon: "🧾" },
  { to: "/inbox", label: "Inbox", icon: "💬" },
  { to: "/customers", label: "Customers", icon: "👥" },
  { to: "/marketing", label: "Marketing", icon: "📣", min: "admin" },
  { to: "/templates", label: "Templates", icon: "🧩", min: "admin" },
  { to: "/automations", label: "Automations", icon: "⚙️", min: "admin" },
  { to: "/reports", label: "Reports", icon: "📈" },
  { to: "/stores", label: "Stores", icon: "🏬" },
  { to: "/team", label: "Team & logs", icon: "🔐", min: "admin" },
];

export default function Layout() {
  const { me, stores, storeId, setStoreId, can, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

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

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.filter((n) => !n.min || can(n.min)).map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
              isActive ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-700/20 dark:text-brand-500" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            )
          }
        >
          <span className="w-5 text-center">{n.icon}</span>
          {n.label}
        </NavLink>
      ))}
      {me?.user?.isSuperAdmin && (
        <NavLink
          to="/admin"
          onClick={() => setOpen(false)}
          className={({ isActive }) => cx("mt-2 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm", isActive ? "bg-purple-50 font-medium text-purple-700 dark:bg-purple-900/30" : "text-purple-700 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-900/20")}
        >
          <span className="w-5 text-center">🛡️</span>Super admin
        </NavLink>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-full">
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-40 w-64 transform border-r border-gray-200 bg-white p-4 transition dark:border-gray-800 dark:bg-gray-900 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="mb-5 flex items-center gap-2 px-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">✓</div>
          <div>
            <div className="text-sm font-semibold leading-tight">WA Commerce</div>
            <div className="text-xs text-gray-500">Shopify × WhatsApp</div>
          </div>
        </div>
        {me?.accounts?.length > 1 && (
          <Select className="mb-3" value={me.accountId || ""} onChange={(e) => switchAccount(e.target.value)}>
            {me.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.viaSuperAdmin ? " (admin view)" : ""}
              </option>
            ))}
          </Select>
        )}
        <Select className="mb-4" value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label="Store">
          <option value="all">All stores ({stores.length})</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {nav}
        <div className="absolute inset-x-4 bottom-4 border-t border-gray-100 pt-3 text-xs dark:border-gray-800">
          <div className="truncate font-medium">{me?.user?.name || me?.user?.email}</div>
          <div className="truncate text-gray-500">
            {me?.user?.email} · {me?.role}
          </div>
          <button onClick={logout} className="mt-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
            Sign out
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {me?.impersonating && (
          <div className="flex items-center justify-between bg-purple-600 px-4 py-2 text-sm text-white">
            <span>You are viewing the portal as {me.user.email}. Actions are logged.</span>
            <button onClick={stopImpersonating} className="rounded bg-white/20 px-2 py-1 hover:bg-white/30">
              Stop impersonating
            </button>
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 lg:hidden">
          <button onClick={() => setOpen(true)} className="text-xl" aria-label="Menu">
            ☰
          </button>
          <span className="font-semibold">WA Commerce</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
