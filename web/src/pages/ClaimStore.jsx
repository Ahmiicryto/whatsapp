import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { get, post } from "../lib/api.js";
import { useSession } from "../lib/session.jsx";
import { Button, ErrorBox, Loading } from "../components/ui.jsx";

/** After installing from Shopify without being signed in: attach the store to your account. */
export default function ClaimStore() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { me, refresh, setStoreId } = useSession();
  const navigate = useNavigate();
  const [shop, setShop] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me) get(`/stores/claim/${encodeURIComponent(token)}`).then((r) => setShop(r.shop)).catch(setError);
  }, [me, token]);

  if (me === undefined) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(`/claim-store?token=${token}`)}`} replace />;

  const account = me.accounts.find((a) => a.id === me.accountId);
  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const r = await post("/stores/claim", { token });
      await refresh();
      setStoreId(String(r.storeId));
      navigate(`/stores/${r.storeId}?connected=1`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-2xl text-white">🏬</div>
        <h1 className="text-lg font-semibold">Link your Shopify store</h1>
        {shop && (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Add <b>{shop}</b> to <b>{account?.name || "your account"}</b>?
          </p>
        )}
        <ErrorBox error={error} />
        {!error && !shop && <Loading label="Checking install…" />}
        {shop && (
          <Button className="w-full" loading={busy} onClick={claim}>
            Link store
          </Button>
        )}
        <p className="text-xs text-gray-500">Signed in as {me.user.email}. Use the account menu to switch business first if needed.</p>
      </div>
    </div>
  );
}
