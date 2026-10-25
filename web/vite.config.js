import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: { outDir: path.join(root, "..", "dist", "web"), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
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
