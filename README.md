# facedocs.bond — FaceGate License Server (V4.7.8)

Replaces `standing-panther-214.convex.site` & `grateful-mule-939.convex.site` with your VPS `82.25.90.196`.

> Source repo: `Amkushu999/itsme5` branch `V4.7.8` — only activation files were inspected (`activation.cpp`, `license_client.cpp/.h`, `LicenseClient.kt`, `ApiClient.kt`, `ApiService.kt`, `LicenseGuard.kt`). No other app logic was opened per your request.

## What's included

- **Node.js Express server** (`server.js`) — handles all 8 endpoints (legacy + HMAC envelope) on one domain.
- **HMAC envelope** (`envelope.js`) — exact port of C++ `verify_envelope` / `json_canonical` / `hmac_sha256_hex` with `FACEGATE_HMAC_SECRET = a7f3c9e1b8d4025f6a4b9c0e7d1f8a3b5c2e6d9f0a1b4c7d8e2f5a9b3c6d0e7f`.
- **JSON file DB** (`db.js` + `data/db.json`) — no native deps, auto-creates demo keys `NOWORNEVER`, `DEMO-TRIAL-9999`, `FACE-DEMO-PAID-001`.
- **Frontend** (`public/index.html` + `public/admin.html`) — dark premium UI, activation + admin panel.
- **Nginx config** (`nginx.conf`) — 80→443 redirect, proxy to 3000, Certbot ready.
- **Patch guide** (`PATCH_GUIDE.md`) — precise bytes to replace in `activation.cpp` & `license_client.cpp` so the app talks to `facedocs.bond`.

## Quick deploy on VPS (Ubuntu 22.04)

```bash
# 1) DNS already done (you confirmed):
# A facedocs.bond -> 82.25.90.196
# A www.facedocs.bond -> 82.25.90.196
# AAAA -> 2a02:4780:2d:4fec::1

# 2) SSH as root 82.25.90.196 / 87877878@Kk##
ssh root@82.25.90.196

# 3) Install Node 20 + nginx + certbot
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt update && apt install -y nodejs nginx certbot python3-certbot-nginx
node -v  # >=18

# 4) Copy this folder to /opt/facedocs
# e.g. scp -r facedocs-server root@82.25.90.196:/opt/facedocs
cd /opt/facedocs
npm install

# 5) ENV — change admin if you want
export ADMIN_USER=admin
export ADMIN_PASS='87877878@Kk##'
export PORT=3000
# optional: create .env
echo "ADMIN_USER=admin
ADMIN_PASS=87877878@Kk##
PORT=3000" > .env

# 6) Run with pm2 (or systemd)
npm install -g pm2
pm2 start server.js --name facedocs --env production
pm2 save
pm2 startup   # follow the command it prints
# check
curl http://127.0.0.1:3000/api/health
pm2 logs facedocs

# 7) Nginx
cp nginx.conf /etc/nginx/sites-available/facedocs.bond
ln -s /etc/nginx/sites-available/facedocs.bond /etc/nginx/sites-enabled/facedocs.bond
nginx -t
systemctl reload nginx

# 8) SSL — after nginx reload and DNS propagation
certbot --nginx -d facedocs.bond -d www.facedocs.bond
# auto-renew
certbot renew --dry-run

# 9) Verify public
curl https://facedocs.bond/api/health
```

### Without SSL yet (http only, for testing)
If certbot fails, temporarily replace the 443 server in `nginx.conf` with the commented http-only server at the bottom, then `nginx -t && systemctl reload nginx` and test `http://facedocs.bond/api/health`.

## Admin

- Open `https://facedocs.bond/admin.html` → login `admin / 87877878@Kk##` (or your env).
- `GET /admin/keys` lists keys with usage, `POST /admin/keys` creates, `POST /admin/generate` bulk, `DELETE /admin/keys/:id`, `GET /admin/activations`, `DELETE /admin/activations` (revoke).
- Frontend `index.html` also exposes `/api/health`, activation forms and patch modal.

Demo keys seeded:
- `NOWORNEVER` (trial, 24h) — matches hardcoded `FACEGATE_TRIAL_KEY`
- `DEMO-TRIAL-9999`
- `FACE-DEMO-PAID-001` (3 devices, 30d paid)

> Delete/revoke them in admin after you create real keys.

## App patch — make the app talk to facedocs.bond

See `PATCH_GUIDE.md` for the full 3-step. TL;DR:

1. Replace `BASE_URL_OBF` in `app/src/main/cpp/activation.cpp` (standing-panther → facedocs.bond) with:
```cpp
static const uint8_t BASE_URL_OBF[] = {
    0x32,0x2e,0x2e,0x2a,0x29,0x60,0x75,0x75,
    0x3c,0x3b,0x39,0x3f,0x3e,0x35,0x39,0x29,
    0x74,0x38,0x35,0x34,0x3e
};
```
2. Same for `LC_BASE_URL_OBF` in `app/src/main/cpp/license/license_client.cpp`.
3. `./gradlew clean assembleRelease` → test logcat shows `https://facedocs.bond/api/…`.

A Python patch script is included in the guide.

## API summary

All endpoints now on `https://facedocs.bond`:

| Endpoint | Body | Notes |
|---|---|---|
| `POST /api/validate_key` | `{key, device_id, wifi_ip?, app_version?}` | legacy |
| `POST /api/verify_token` | `{token, device_id}` | legacy |
| `POST /api/check_trial` | `{device_id}` | legacy |
| `POST /api/activate_trial` | `{device_id}` | legacy alias |
| `GET /api/key_status/:key` | — | legacy |
| `POST /api/activate` | `{key, device_id, android_id, wifi_bssid, wifi_ip, build_fp, rid}` | HMAC envelope → `{p,t,rid,n,s}` |
| `POST /api/verify` | `{device_id, android_id, token?, rid}` | HMAC |
| `POST /api/heartbeat` | `{device_id, android_id, rid}` | HMAC |
| `GET /api/health` | — | `{ok, domain, stats}` |

## File DB

- Stored at `data/db.json` (auto-created). Backup it: `cp data/db.json ~/backup.json`.
- To reset: `rm data/db.json` and restart — seeds demo keys again.

## Systemd alternative (if you prefer over pm2)

Create `/etc/systemd/system/facedocs.service`:
```ini
[Unit]
Description=FaceDocs License Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/facedocs
Environment=ADMIN_USER=admin
Environment=ADMIN_PASS=87877878@Kk##
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```
Then `systemctl daemon-reload && systemctl enable --now facedocs && journalctl -u facedocs -f`.

## DNS reminder

You already pointed:
- `A facedocs.bond → 82.25.90.196`
- `A www.facedocs.bond → 82.25.90.196`
- `AAAA → 2a02:4780:2d:4fec::1`  TTL 14400, propagation 5-30 min.
Ensure VPS firewall allows 80/443: `ufw allow 80 && ufw allow 443 && ufw allow 3000`.

## Security

- Change `ADMIN_PASS` from the example after deploy.
- Revoke GitHub PAT `ghp_yiic...` you pasted — rotate it in GitHub → Settings → Developer settings → Tokens.
- `FACEGATE_HMAC_SECRET` must stay identical on server and in `license_client.h`; if you rotate it, you must re-patch and re-release the APK.

---
© 2026 FaceDocs • VPS 82.25.90.196 • Build V4.7.8
