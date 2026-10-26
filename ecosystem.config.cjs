// PM2 on a plain VPS (no Docker):  npm ci && npm run build && pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    { name: "wa-web", script: "src/server.js", env: { NODE_ENV: "production" }, max_memory_restart: "600M" },
    { name: "wa-worker", script: "src/worker.js", env: { NODE_ENV: "production" }, max_memory_restart: "600M" },
    // Optional QR gateway: run `npm install` inside gateway/ first
    // { name: "wa-gateway", cwd: "gateway", script: "index.js", env: { NODE_ENV: "production", PORT: 4000 } },
  ],
};
