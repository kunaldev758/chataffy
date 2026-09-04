#!/bin/bash

set -e

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "Node Version:"
node -v

echo "NPM Version:"
npm -v

echo ""
echo "========================================"



SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_SRC="${SCRIPT_DIR}/.env.production"
SSH_KEY="C:\chataffy/chataffy-live.pem"
SSH_HOST="ubuntu@3.231.129.216"
REMOTE_APP_DIR="/var/www/chataffy.com/chataffy_be"
ENV_DST="${SSH_HOST}:${REMOTE_APP_DIR}/.env"

REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: Could not find git repository (started from $SCRIPT_DIR)"
  exit 1
fi

CURRENT_BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
if [ -z "$CURRENT_BRANCH" ]; then
  echo "ERROR: Could not determine current git branch in $REPO_ROOT"
  exit 1
fi

if [ ! -f "$ENV_SRC" ]; then
  echo "ERROR: $ENV_SRC not found"
  exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
  echo "ERROR: SSH key not found at $SSH_KEY"
  exit 1
fi

echo "========================================"
echo "Starting Deployment Script"
echo "========================================"

echo "Local Current Branch: $CURRENT_BRANCH"
echo "Connecting to EC2 Server..."

ssh -i "$SSH_KEY" "$SSH_HOST" << EOF

set -e

echo ""
echo "========================================"
echo "Connected to EC2 Successfully"
echo "========================================"

echo "Current Server User:"
whoami

echo ""
echo "Moving to Project Directory..."
cd ${REMOTE_APP_DIR}

echo "Current Directory:"
pwd

echo ""
echo "Adding Git Safe Directory..."
git config --global --add safe.directory ${REMOTE_APP_DIR}

echo ""
echo "Checking Current Git Branch on Server..."
git branch --show-current

echo ""
echo "Fetching Latest Code from GitHub..."
git fetch origin

echo ""
echo "Switching to Branch: $CURRENT_BRANCH"
git checkout $CURRENT_BRANCH

echo ""
echo "Resetting Code to Latest Origin Branch..."
git reset --hard origin/$CURRENT_BRANCH

echo ""
echo "Latest Commit Details:"
git log -1

echo ""
echo "Installing Dependencies..."
npm install

EOF

echo ""
echo "Backing up remote .env (if present)..."
ssh -i "$SSH_KEY" "$SSH_HOST" \
  "cp ${REMOTE_APP_DIR}/.env ${REMOTE_APP_DIR}/.env.bak.\$(date +%Y%m%d%H%M%S) 2>/dev/null || true"

echo "Copying .env.production to production .env..."
scp -i "$SSH_KEY" "$ENV_SRC" "$ENV_DST"

ssh -i "$SSH_KEY" "$SSH_HOST" << EOF

set -e

cd ${REMOTE_APP_DIR}

echo ""
echo "Restarting PM2 Backend Process..."
pm2 restart backend

echo ""
echo "Checking PM2 Status..."
pm2 status

echo ""
echo "========================================"
echo "Updating Nginx (subdomain config)"
echo "========================================"

NGINX_SRC="${REMOTE_APP_DIR}/nginx/nginx.conf"
NGINX_DST="/etc/nginx/sites-available/default"

if [ ! -f "\$NGINX_SRC" ]; then
  echo "ERROR: \$NGINX_SRC not found. Aborting nginx update."
  exit 1
fi

echo "Backing up current nginx site config..."
sudo cp "\$NGINX_DST" "\$NGINX_DST.bak.\$(date +%Y%m%d%H%M%S)" 2>/dev/null || true

echo "Installing nginx config from repo..."
sudo cp "\$NGINX_SRC" "\$NGINX_DST"

echo "Testing nginx configuration..."
sudo nginx -t

echo "Reloading nginx..."
sudo systemctl reload nginx

echo ""
echo "Nginx status:"
sudo systemctl status nginx --no-pager || true

echo ""
echo "Uploaded .env from local .env.production"
echo ""
echo "========================================"
echo "Deployment Completed Successfully"
echo "========================================"

EOF

echo ""
echo "SSH Session Closed"
echo "Deployment Script Finished"
