#!/bin/bash
# Deploys the RoadGuard backend to a Linux server (e.g. an Azure for Students VM) with real HTTPS,
# straight from this Mac. Run it again any time to ship backend changes; data is kept.
#
#   bash ~/Projects/RoadGuard/ops/deploy_server.sh <server-ip> <ssh-key-file> [ssh-user]
#   e.g. bash ~/Projects/RoadGuard/ops/deploy_server.sh 20.204.10.7 ~/Downloads/roadguard-vm_key.pem
#
# The server gets the free HTTPS name <ip-with-dashes>.sslip.io (Caddy fetches a Let's Encrypt
# certificate for it). The app build is pointed at that address.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

IP="${1:-}"; KEY="${2:-}"; SSH_USER="${3:-azureuser}"
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Usage: bash $0 <server-ip> <ssh-key-file> [ssh-user]   (the IP is on the VM's Overview page)"
[ -f "$KEY" ] || die "SSH key file not found: $KEY (the .pem Azure downloaded when you created the VM)"
chmod 600 "$KEY"
DOMAIN="${IP//./-}.sslip.io"
URL="https://$DOMAIN"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
remote() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$IP" "$@"; }

bold "Connecting to ${SSH_USER}@${IP}..."
remote true || die "Couldn't connect. Check the IP, that the key matches the VM, and that port 22 (SSH) is open in the VM's Networking settings."

# ---------------------------------------------------------------- settings (first deploy only)
NEW_PASSWORD=""; ADMIN_EMAIL=""
if ! remote test -f roadguard/backend/.env; then
  bold "First deploy: dashboard login for the live server"
  read -r -p "Your email for the city dashboard: " ADMIN_EMAIL
  [[ "$ADMIN_EMAIL" == *@*.* ]] || die "That doesn't look like an email address."
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
  printf 'DOMAIN=%s\nJWT_SECRET=%s\nADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\nADMIN_NAME=RoadGuard Admin\n' \
    "$DOMAIN" "$(openssl rand -hex 32)" "$ADMIN_EMAIL" "$NEW_PASSWORD" \
    | remote 'mkdir -p roadguard/backend && umask 077 && cat > roadguard/backend/.env'
else
  # Keep everything, but follow the server if its IP (and so its sslip.io name) changed.
  remote "sed -i 's|^DOMAIN=.*|DOMAIN=$DOMAIN|' roadguard/backend/.env"
fi

# ---------------------------------------------------------------- code
bold "Uploading the backend…"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude data-live --exclude .env --exclude '*.log' \
  -e "ssh ${SSH_OPTS[*]}" "$ROOT/backend/" "$SSH_USER@$IP:roadguard/backend/"
# The container runs as the unprivileged "node" user, so the code must be world-readable even if
# the Mac copies are owner-only. The secrets file stays private.
remote 'chmod -R a+rX roadguard/backend && chmod 600 roadguard/backend/.env'

# ---------------------------------------------------------------- server setup + start
bold "Setting up the server and starting RoadGuard (first time: about 5 minutes)…"
remote 'bash -s' <<'REMOTE'
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
fi
# 1 GB VMs run out of memory during the image build without some swap.
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
cd ~/roadguard/backend
sudo docker compose up -d --build
sudo docker image prune -f >/dev/null
REMOTE

bold "Waiting for HTTPS on $URL (the first certificate takes up to a couple of minutes)…"
ok=""
for _ in $(seq 1 36); do
  if curl -fsS --max-time 10 "$URL/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || die "Not reachable over HTTPS yet. Check that ports 80 and 443 are open in the VM's Networking settings, then run this again. Server logs: ssh -i $KEY $SSH_USER@$IP 'cd roadguard/backend && sudo docker compose logs --tail 80'"

# ---------------------------------------------------------------- point the app at it
GP="$ROOT/gradle.properties"
if grep -qE '^roadguard.serverUrl=' "$GP"; then /usr/bin/sed -i '' "s|^roadguard.serverUrl=.*|roadguard.serverUrl=$URL/|" "$GP"; else printf '\n# Server the app uses (set by ops/deploy_server.sh)\nroadguard.serverUrl=%s/\n' "$URL" >> "$GP"; fi

bold "RoadGuard is live on the server"
echo "  App server:  $URL/"
echo "  Dashboard:   $URL/admin/"
if [ -n "$NEW_PASSWORD" ]; then
  echo "  Login:       $ADMIN_EMAIL"
  echo "  Password:    $NEW_PASSWORD   (shown once: save it in your password manager)"
fi
echo
echo "  Ship backend changes: run this same command again."
echo "  Logs: ssh -i $KEY $SSH_USER@$IP 'cd roadguard/backend && sudo docker compose logs -f'"
echo "  Next: bash ~/Projects/RoadGuard/ops/build_release.sh   (the app now talks to $URL/)"
