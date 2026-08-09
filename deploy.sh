#!/usr/bin/env bash
# deploy.sh — one-shot deploy helper for 82.25.90.196
set -e
echo "== FaceDocs deploy =="

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt update && apt install -y nodejs nginx
fi

echo "Node $(node -v)  NPM $(npm -v)"

if [ ! -d "node_modules" ]; then
  npm install
fi

# env
if [ ! -f ".env" ]; then
  cat > .env << 'ENV'
ADMIN_USER=admin
ADMIN_PASS=87877878@Kk##
PORT=3000
ENV
  echo "Created .env — EDIT ADMIN_PASS after!"
fi

# pm2
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi
pm2 delete facedocs 2>/dev/null || true
pm2 start server.js --name facedocs
pm2 save || true
echo "PM2 started. Health check:"
sleep 2
curl -s http://127.0.0.1:3000/api/health | head -c 500; echo

# nginx
if [ -f "nginx.conf" ]; then
  cp nginx.conf /etc/nginx/sites-available/facedocs.bond
  ln -sf /etc/nginx/sites-available/facedocs.bond /etc/nginx/sites-enabled/facedocs.bond
  nginx -t && systemctl reload nginx || echo "nginx reload failed — check config"
  echo "Nginx configured. Next: certbot --nginx -d facedocs.bond -d www.facedocs.bond"
fi

echo "DONE. Visit https://facedocs.bond (or http://facedocs.bond if no cert yet) and /admin.html"
