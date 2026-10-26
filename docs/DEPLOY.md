# Deploying WA Commerce anywhere

The app has 3 parts, plus Postgres:

| Part | What it does | Command |
|---|---|---|
| **web** | API, portal and webhooks | `node src/server.js` |
| **worker** | background jobs and schedules (confirmations, reminders, courier tracking, reports) | `node src/worker.js` |
| **gateway** (optional) | WhatsApp QR login; needs an always-on server | `cd gateway && node index.js` |

Pick the row that matches your hosting:

| Hosting type | Use | Notes |
|---|---|---|
| Serverless (Vercel, Netlify, AWS Lambda, Cloud Run scale-to-zero) | web only + a cron calling `/api/cron/tick` every minute | Set `SERVERLESS=true` on non-Vercel hosts. The QR gateway must run somewhere else. |
| Platform-as-a-service (Render, Railway, Heroku, Fly.io, DigitalOcean App Platform, Koyeb) | web + worker processes | `render.yaml`, `Procfile` and `fly.toml` are included. |
| VPS / dedicated (Hetzner, Contabo, DigitalOcean, AWS EC2/Lightsail, any Ubuntu) | Docker Compose (everything incl. Postgres + HTTPS) or PM2 | Cheapest for many stores. |
| Self-hosted panels (Coolify, Dokploy, CapRover, Portainer) | point them at `docker-compose.yml` or the `Dockerfile` | |
| Shared hosting with Node.js (cPanel "Setup Node.js App", Hostinger, Plesk) | web only with `RUN_WORKER_IN_PROCESS=true` | Use an external Postgres (Neon, Supabase). No QR gateway. |

## Required environment variables

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host/db` | Use the **pooled** URL on serverless. |
| `DATABASE_SSL` | `true` | `true` for hosted Postgres (Neon, Supabase, RDS…). |
| `SESSION_SECRET` | `openssl rand -base64 32` | |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` | Never change it after data exists. |
| `APP_BASE_URL` | `https://app.yourdomain.com` | Auto-detected on Vercel, Render, Railway, Fly and Netlify. |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | | Your admin login, created on first start. |
| `CRON_SECRET` | random | Only for serverless (`/api/cron/tick`). |

Optional ones are in `.env.example`:
- Meta: `META_*`
- Shopify: `SHOPIFY_*`
- QR gateway: `GATEWAY_*`
- AI: `OPENAI_API_KEY`, `GEMINI_API_KEY`
- Google: `GOOGLE_MAPS_API_KEY`
- Billing: `STRIPE_*`, `BILLING_ENABLED`

Database tables are created and upgraded automatically on startup.

---

## 1. VPS with Docker (recommended for full control)

On a fresh Ubuntu 22/24 server with at least 1 GB RAM:

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/YOU/whatsapp.git && cd whatsapp
cp .env.example .env && nano .env      # set the secrets, POSTGRES_PASSWORD, DOMAIN, APP_BASE_URL=https://DOMAIN
docker compose --profile https up -d --build
```

- Point your domain's DNS **A record** to the server IP. Caddy gets the HTTPS certificate automatically.
- To update: `git pull && docker compose --profile https up -d --build`.
- To back up: `docker compose exec db pg_dump -U wa wa > backup.sql`.
- Logs: `docker compose logs -f web worker`.

## 2. VPS without Docker (PM2 + Nginx)

```bash
# Node 22 + PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs nginx
sudo npm i -g pm2
git clone https://github.com/YOU/whatsapp.git && cd whatsapp
cp .env.example .env && nano .env
npm ci --include=dev && npm run build
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

Nginx site (`/etc/nginx/sites-available/wa`), then `sudo certbot --nginx -d app.yourdomain.com`:

```nginx
server {
  server_name app.yourdomain.com;
  client_max_body_size 20m;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
}
```

## 3. Vercel

1. Import the repo.
2. Add Neon from Storage.
3. Set the variables above, plus `CRON_SECRET`.
4. Have cron-job.org call `https://DOMAIN/api/cron/tick` every minute with the header `Authorization: Bearer <CRON_SECRET>`. Vercel Pro can use `vercel.json` instead.

## 4. Render

**New → Blueprint** reads `render.yaml`, which creates the web service, worker, Postgres and optional gateway.

## 5. Railway

1. New project → **Deploy from GitHub**. Railway reads the `Procfile`.
2. Add a **Postgres** plugin and set `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Duplicate the service for the worker and set its start command to `node src/worker.js`.

## 6. Fly.io

```bash
fly launch --no-deploy        # keeps the included fly.toml
fly postgres create && fly postgres attach <db-name>
fly secrets set SESSION_SECRET=... ENCRYPTION_KEY=... SUPER_ADMIN_EMAIL=... SUPER_ADMIN_PASSWORD=...
fly deploy && fly scale count web=1 worker=1
```

## 7. Heroku / Dokku / Scalingo

`git push heroku main`. The `Procfile` runs migrations on release and starts `web` and `worker`. Add the Heroku Postgres add-on.

## 8. Coolify, Dokploy, CapRover

Create a **Docker Compose** application from the repo, using `docker-compose.yml`. Fill in the environment variables in the panel. Let the panel's proxy handle HTTPS (skip the `https` profile).

## 9. cPanel / Hostinger / Plesk (Node.js App)

1. Upload the repo, or use Git™ Version Control.
2. Run `npm ci --include=dev && npm run build` from the terminal.
3. In **Setup Node.js App**: Node 22, startup file `src/server.js`. Add the environment variables, including `RUN_WORKER_IN_PROCESS=true` and an external `DATABASE_URL` (Neon free tier).
4. Restart the app.

## 10. Google Cloud Run / AWS App Runner / Azure Container Apps

Build the `Dockerfile`. Run one service with the default command (web) and keep **min instances = 1**.
- Either run a second service with command `node src/worker.js`,
- or set `RUN_WORKER_IN_PROCESS=true` on the web service.
- If it scales to zero, set `SERVERLESS=true` and add a scheduler (Cloud Scheduler / EventBridge) that calls `/api/cron/tick` every minute with the `CRON_SECRET` bearer header.

---

## After deploying (any host)

1. Open `https://DOMAIN/healthz`. It should return `{"ok":true}`.
2. Sign in with the super admin email at `/login`.
3. Shopify Dev Dashboard → App URL `https://DOMAIN/shopify/install`, Redirect `https://DOMAIN/shopify/callback`.
4. Meta app → WhatsApp → webhook `https://DOMAIN/webhooks/whatsapp` with your verify token.
5. Optional Stripe webhook → `https://DOMAIN/webhooks/stripe`. Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
