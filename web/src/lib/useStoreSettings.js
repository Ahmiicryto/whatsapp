import { useEffect, useState } from "react";
import { useApi, put } from "./api.js";

/** Loads a store's merged settings and offers a draft + save of partial changes. */
export function useStoreSettings(storeId) {
  const res = useApi(storeId ? `/stores/${storeId}` : null);
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (res.data?.settings) setDraft(structuredClone(res.data.settings));
  }, [res.data]);

  /** set("confirmation.reminderHours", 4) */
  function set(path, value) {
    setDraft((d) => {
      const next = structuredClone(d);
      const keys = path.split(".");
      let o = next;
      for (const k of keys.slice(0, -1)) o = o[k];
      o[keys.at(-1)] = value;
      return next;
    });
  }
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), draft);
  async function save(sections) {
    const body = sections ? Object.fromEntries(sections.map((s) => [s, draft[s]])) : draft;
    const saved = await put(`/stores/${storeId}/settings`, body);
    setDraft(structuredClone(saved));
    return saved;
  }
  return { ...res, draft, set, get, save };
}
