# Nginx config for Chataffy (subdomains)

Canonical config: `nginx.conf` in this folder.

## What it does

- `chataffy.com`, `www`, `dashboard.chataffy.com`, `agent.chataffy.com` → Next.js (`127.0.0.1:9001`)
- `/api/`, `/socket.io/` → backend (`127.0.0.1:9000`)
- `/chataffy/chataffy/` → legacy backend path (remove when `BASE_URL` uses `/api/` only)
- `/chataffy/cahtaffy_fe` → legacy frontend (Next.js middleware 301s to subdomains)
- `/chataffy/superadmin` → static superadmin build

## Deploy

`new-backend/server.sh` copies this file to `/etc/nginx/sites-available/default`, runs `nginx -t`, and reloads nginx on each backend deploy.

## One-time setup (run on EC2 before first subdomain deploy)

1. DNS A/CNAME: `dashboard.chataffy.com`, `agent.chataffy.com` → server IP.

2. Expand SSL certificate:

```bash
sudo certbot certonly --nginx \
  -d chataffy.com -d www.chataffy.com \
  -d dashboard.chataffy.com -d agent.chataffy.com
```

3. Deploy backend (`server.sh`) then frontend (`cahtaffy_fe/server.sh`) with production env from `DEPLOY-SUBDOMAINS.md`.

## Verify

```bash
sudo nginx -t
curl -I https://chataffy.com/
curl -I https://dashboard.chataffy.com/login
curl -I https://agent.chataffy.com/agent-login
```
