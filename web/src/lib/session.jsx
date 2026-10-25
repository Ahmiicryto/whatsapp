import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api.js";

const SessionCtx = createContext(null);
export const useSession = () => useContext(SessionCtx);

const STORE_KEY = "wa.storeId";

export function SessionProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [storeId, setStoreIdState] = useState(() => localStorage.getItem(STORE_KEY) || "all");

  const refresh = useCallback(async () => {
    try {
      setMe(await api("/auth/me"));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    const h = () => setMe(null);
    window.addEventListener("wa:unauthorized", h);
    return () => window.removeEventListener("wa:unauthorized", h);
  }, [refresh]);

  // keep the selected store valid for this account
  useEffect(() => {
    if (!me?.stores) return;
    if (storeId !== "all" && !me.stores.some((s) => String(s.id) === String(storeId))) setStoreId("all");
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  function setStoreId(id) {
    localStorage.setItem(STORE_KEY, String(id));
    setStoreIdState(String(id));
  }

  const role = me?.role;
  const rank = { viewer: 1, agent: 2, admin: 3, owner: 4 }[role] || 0;
  const value = {
    me,
    refresh,
    storeId,
    setStoreId,
    stores: me?.stores || [],
    currentStore: me?.stores?.find((s) => String(s.id) === String(storeId)) || null,
    can: (min) => me?.user?.isSuperAdmin || rank >= { viewer: 1, agent: 2, admin: 3, owner: 4 }[min],
  };
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

/** For pages that need one concrete store (settings, templates...). */
export function useSingleStore() {
  const s = useSession();
  const store = s.currentStore || s.stores[0] || null;
  return { ...s, store, storeIdNum: store?.id ?? null };
}
