import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(root, "..", "dist", "web"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Long-lived vendor files: app releases don't force users to re-download React or the chart library.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](recharts|d3-|victory-vendor|decimal\.js-light|lodash)/.test(id)) return "charts";
          if (/[\\/]@zxing[\\/]/.test(id)) return "scanner";
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run)[\\/]/.test(id)) return "react";
          if (/[\\/]lucide-react[\\/]/.test(id)) return "icons";
          return "vendor";
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/media": "http://localhost:3000",
      "/r": "http://localhost:3000",
      "/shopify": "http://localhost:3000",
    },
  },
});
