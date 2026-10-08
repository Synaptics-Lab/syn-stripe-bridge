#!/usr/bin/env bash
# syn-stripe-bridge — PM2 daemon deployment (self-check-before-kill law)
#
# 1. Fail loud unless the required 0600 envs exist (custody key + registry).
# 2. PRE-FLIGHT: boot the replacement on a scratch port (:8093) and health-
#    check it BEFORE touching any running instance — never kill a live
#    service on an unverified replacement.
# 3. Only then stop/delete any existing :8092 instance and start the verified
#    one, and health-check it again. pm2 save.
set -euo pipefail

APP_NAME="syn-stripe-bridge"
PORT="${STRIPEShim_PORT_OVERRIDE:-8092}"
SCRATCH_PORT="${PORT}"
[ -n "${STRIPEShim_PORT_OVERRIDE:-}" ] && SCRATCH_PORT=8093
SCRATCH_PORT=8093 # pre-flight surface — never the live port
HOST="127.0.0.1"

: "${BRIDGE_CUSTODY_KEY_FILE:?BRIDGE_CUSTODY_KEY_FILE required (0600 custody key}"
: "${BRIDGE_MERCHANTS_FILE:?BRIDGE_MERCHANTS_FILE required (0600 merchant registry}"
: "${BRIDGE_DATA_DIR:?BRIDGE_DATA_DIR required (append-only ledger dir)}"

[ -f "$BRIDGE_CUSTODY_KEY_FILE" ] || { echo "REFUSED: $BRIDGE_CUSTODY_KEY_FILE missing"; exit 1; }
[ -f "$BRIDGE_MERCHANTS_FILE" ]   || { echo "REFUSED: $BRIDGE_MERCHANTS_FILE missing"; exit 1; }

command -v pm2 >/dev/null 2>&1 || { echo "pm2 not found — npm install -g pm2 first"; exit 1; }

echo "== pre-flight boot on :$SCRATCH_PORT (self-check before any kill) =="
STRIPE_SHIM_PORT="$SCRATCH_PORT" STRIPE_SHIM_HOST="$HOST" \
  node src/stripe_shim.mjs &
PF_PID=$!
PF_OK=""
for _ in $(seq 1 10); do
  sleep 0.5
  if curl -sf "http://$HOST:$SCRATCH_PORT/health" | grep -q '"ok":true'; then PF_OK=1; break; fi
 done
kill "$PF_PID" 2>/dev/null || true
wait "$PF_PID" 2>/dev/null || true
[ -n "$PF_OK" ] || { echo "REFUSED: pre-flight /health failed — the LIVE service on :$PORT is untouched"; exit 1; }
echo "pre-flight OK"

if pm2 describe "$APP_NAME" --no-color 2>/dev/null | grep -q '"status"'; then
  echo "== replacing existing instance (replacement verified first) =="
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
fi

STRIPE_SHIM_PORT="$PORT" STRIPE_SHIM_HOST="$HOST" pm2 start src/stripe_shim.mjs \
  --name "$APP_NAME" --time --max-memory-restart 200M >/dev/null

ok=""
for _ in $(seq 1 10); do
  sleep 0.5
  if curl -sf "http://$HOST:$PORT/health" | grep -q '"ok":true'; then ok=1; break; fi
done
pm2 save >/dev/null
[ -n "$ok" ] || { echo "DEPLOY FAILED: :$PORT did not become healthy"; exit 1; }

echo "✅ $APP_NAME live on http://$HOST:$PORT"
curl -s "http://$HOST:$PORT/health" | head -c 400; echo