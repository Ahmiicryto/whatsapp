import { useState } from "react";
import { Button, Field, Input } from "../components/ui.jsx";

/** Public page: a merchant types their store and is sent to Shopify to approve the app. */
export default function Install() {
  const [shop, setShop] = useState("");
  const domain = (() => {
    let s = shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (s && !s.includes(".")) s = `${s}.myshopify.com`;
    return s;
  })();
  const valid = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-50 to-white p-4 dark:from-gray-950 dark:to-gray-900">
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) window.location.href = `/shopify/install?shop=${encodeURIComponent(domain)}`;
        }}
      >
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-600 text-2xl text-white">✓</div>
          <h1 className="text-lg font-semibold">Connect your Shopify store</h1>
          <p className="text-sm text-gray-500">You'll approve access in Shopify, then your store is linked automatically.</p>
        </div>
        <Field label="Your store" hint={domain && !valid ? "Use your myshopify.com name, e.g. glowcandles" : domain ? domain : "e.g. glowcandles or glowcandles.myshopify.com"}>
          <Input value={shop} onChange={(e) => setShop(e.target.value)} placeholder="yourstore" autoFocus />
        </Field>
        <Button className="w-full" disabled={!valid}>
          Continue to Shopify
        </Button>
      </form>
    </div>
  );
}
