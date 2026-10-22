#!/bin/bash
# Puts the RoadGuard server online from this Mac: always running, real HTTPS, reachable from any
# phone on any network, through Tailscale Funnel (free). Safe to run again at any time.
#
#   bash ~/Projects/RoadGuard/ops/go_live_mac.sh          # set up or update, then start
#   bash ~/Projects/RoadGuard/ops/go_live_mac.sh status   # is it up?
#   bash ~/Projects/RoadGuard/ops/go_live_mac.sh stop     # take it offline
#
# The live server keeps its own database in backend/data-live/, separate from the demo data in
# backend/data/, so test reports never mix with the fake Dehradun demo hazards.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
ENV_FILE="$BACKEND/.env"
LABEL="com.roadguard.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$BACKEND/data-live/logs"
PORT_DEFAULT=5050

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*"; exit 1; }

find_tailscale() {
  local ts; ts="$(command -v tailscale || true)"
  [ -z "$ts" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  echo "$ts"
}
TS="$(find_tailscale)"

case "${1:-start}" in
  stop)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    [ -n "$TS" ] && "$TS" funnel reset 2>/dev/null || true
    echo "RoadGuard server stopped and taken offline. Run this script again to bring it back."
    exit 0 ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "Server: running" || echo "Server: not running"
    [ -n "$TS" ] && "$TS" funnel status 2>/dev/null || true
    exit 0 ;;
  start) ;;
  *) die "Unknown option '$1'. Use: start, status or stop." ;;
esac

# ---------------------------------------------------------------- 1. checks
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js isn't installed. Install the LTS version from https://nodejs.org, then run this again."
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is installed; RoadGuard needs Node 20 or newer."
[ -n "$TS" ] || die "Tailscale isn't installed. Get it from https://tailscale.com/download/mac (free), open it, sign in, then run this again."
"$TS" status >/dev/null 2>&1 || die "Tailscale isn't signed in. Open the Tailscale app from the menu bar, sign in, then run this again."
DNS=$("$TS" status --json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(((j.Self&&j.Self.DNSName)||"").replace(/\.$/,""))}catch(e){}})')
[ -n "$DNS" ] || die "Couldn't read this Mac's Tailscale name. In the Tailscale admin console, make sure MagicDNS is on."
URL="https://$DNS"

# ---------------------------------------------------------------- 2. settings in backend/.env
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
getenv() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
setenv() {
  if grep -qE "^$1=" "$ENV_FILE"; then /usr/bin/sed -i '' "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
PORT="$(getenv PORT)"; [ -n "$PORT" ] || { PORT=$PORT_DEFAULT; setenv PORT "$PORT"; }
JWT="$(getenv JWT_SECRET)"
if [ -z "$JWT" ] || [ "$JWT" = "change-me-to-a-long-random-string" ]; then setenv JWT_SECRET "$(openssl rand -hex 32)"; fi
setenv DATA_DIR ./data-live
setenv PUBLIC_BASE_URL "$URL"

NEW_PASSWORD=""
ADMIN_EMAIL="$(getenv ADMIN_EMAIL)"
if [ -z "$ADMIN_EMAIL" ] || [ "$ADMIN_EMAIL" = "admin@roadguard.local" ]; then
  bold "Dashboard login for the live server"
  read -r -p "Your email for the city dashboard: " ADMIN_EMAIL
  [[ "$ADMIN_EMAIL" == *@*.* ]] || die "That doesn't look like an email address. Run the script again."
  setenv ADMIN_EMAIL "$ADMIN_EMAIL"
fi
ADMIN_PASSWORD="$(getenv ADMIN_PASSWORD)"
if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "change-this-password" ]; then
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
  setenv ADMIN_PASSWORD "$NEW_PASSWORD"
fi
[ -n "$(getenv ADMIN_NAME)" ] || setenv ADMIN_NAME "RoadGuard Admin"
mkdir -p "$LOGDIR"

# ---------------------------------------------------------------- 3. dependencies
if [ ! -d "$BACKEND/node_modules" ]; then
  bold "Installing server dependencies (one time)…"
  (cd "$BACKEND" && npm ci --omit=dev --no-audit --no-fund)
fi

# ---------------------------------------------------------------- 4. run it as a background service
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# A server started by hand in Terminal (npm start) holds the port: stop it, the service replaces it.
OLD=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD" ]; then
  echo "Stopping the server already running on port $PORT (it is replaced by the background service)…"
  kill $OLD 2>/dev/null || true; sleep 2
fi
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -s keeps the Mac awake while it's on charger, so the server stays reachable -->
    <string>/usr/bin/caffeinate</string><string>-s</string>
    <string>$NODE</string><string>src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$BACKEND</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server-error.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Starting the server…"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || die "The server didn't start. The reason is at the end of: $LOGDIR/server-error.log"

# ---------------------------------------------------------------- 5. HTTPS on the internet
bold "Opening $URL to the internet with Tailscale Funnel…"
if ! "$TS" funnel --bg "$PORT"; then
  die "Tailscale needs Funnel switched on for your account once. Open the link printed above, approve it, then run this script again."
fi
echo "Checking it from the internet (the first certificate can take up to a minute)…"
pub=""
for _ in $(seq 1 12); do
  if curl -fsS --max-time 10 "$URL/api/health" >/dev/null 2>&1; then pub=1; break; fi
  sleep 5
done

# ---------------------------------------------------------------- 6. point the app at it
GP="$ROOT/gradle.properties"
if grep -qE '^roadguard.serverUrl=' "$GP"; then /usr/bin/sed -i '' "s|^roadguard.serverUrl=.*|roadguard.serverUrl=$URL/|" "$GP"; else printf '\n# Server the app uses (set by ops/go_live_mac.sh)\nroadguard.serverUrl=%s/\n' "$URL" >> "$GP"; fi

bold "RoadGuard is live"
echo "  App server:  $URL/"
echo "  Dashboard:   $URL/admin/"
echo "  Login:       $ADMIN_EMAIL"
if [ -n "$NEW_PASSWORD" ]; then
  echo "  Password:    $NEW_PASSWORD"
  echo "               (shown once; it's also in backend/.env. Save it in your password manager.)"
fi
[ -n "$pub" ] || echo "  Note: not reachable from the internet yet. Give it a minute, then: bash $0 status"
echo
echo "  It starts by itself when you log in to this Mac and restarts if it crashes."
echo "  Keep the Mac on charger with the lid open: a sleeping Mac means no server."
echo "  Logs: $LOGDIR"
echo "  Next: build the app (bash ~/Projects/RoadGuard/ops/build_release.sh). It now talks to $URL/"
