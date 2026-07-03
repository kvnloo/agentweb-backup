#!/usr/bin/env bash
# check-reachability.sh — PROVE a kept preview is reachable from THIS machine.
# Run from your laptop:  bash check-reachability.sh <public-ip> <bug-id>
#
# Port picks the portal, host (bug-id) picks the bug:
#   partner  = <bug>.<ip>.nip.io:5173     customer = <bug>.<ip>.nip.io:5174
#   API      = <bug>.<ip>.nip.io:3001
# Override ports via PARTNER_PORT / CUSTOMER_PORT / API_PORT to match config.previewPorts.
set -uo pipefail

IP="${1:?usage: check-reachability.sh <public-ip> <bug-id>}"
BUG="$(printf '%s' "${2:?bug id required}" | tr '[:upper:]' '[:lower:]')"
PARTNER_PORT="${PARTNER_PORT:-5173}"
CUSTOMER_PORT="${CUSTOMER_PORT:-5174}"
API_PORT="${API_PORT:-3001}"
# Dash-separated IP for nip.io: dotted <bug>.<ip> is mis-parsed when the bug id ends in digits.
IPDASH="$(printf '%s' "$IP" | tr '.' '-')"
HOST="${BUG}.${IPDASH}.nip.io"

pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail(){ printf '  \033[31mFAIL\033[0m %s\n       fix: %s\n' "$1" "$2"; }
code(){ local c; c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null)"; printf '%s' "${c:-000}"; }

echo "Reachability check for '$BUG' at $IP (partner:$PARTNER_PORT customer:$CUSTOMER_PORT api:$API_PORT)"

# --- L1: proxy reachable on each portal port (Host-agnostic health endpoint) ---
l1fail=0
for pp in "customer:$CUSTOMER_PORT" "partner:$PARTNER_PORT" "api:$API_PORT"; do
  role="${pp%%:*}"; port="${pp##*:}"
  if [ "$(curl -s --max-time 6 "http://${IP}:${port}/__preview_health__" 2>/dev/null)" = "preview-proxy-ok" ]; then
    pass "L1 proxy reachable on :${port} (${role})"
  else
    fail "L1 :${port} (${role}) NOT reachable" \
         "open it to your IP: allow-ip.sh <your-ip> OPEN_PREVIEW_PORT=true; and ensure proxy.mjs runs on the box"
    l1fail=1
  fi
done
[ "$l1fail" = 1 ] && { echo "  Stopping — later layers depend on L1."; exit 1; }

# --- L2: nip.io DNS (best-effort; diagnostic only) ---
resolve(){ command -v dig >/dev/null && dig +short "$1" | tail -n1 && return; \
           command -v nslookup >/dev/null && nslookup "$1" 2>/dev/null | awk '/^Address: /{a=$2} END{print a}'; }
R="$(resolve "$HOST" 2>/dev/null || true)"
if [ -z "$R" ]; then echo "  SKIP L2 (no dig/nslookup, or DNS blocked) — L3 still proves it end-to-end"
elif [ "$R" = "$IP" ]; then pass "L2 DNS ${HOST} -> ${IP}"
else fail "L2 DNS ${HOST} -> ${R} (expected ${IP})" "wrong public IP, or PREVIEW_IP baked a different one"
fi

# --- L3: each portal returns HTTP (route registered + app up + PREVIEW_IP match) ---
for pp in "customer:$CUSTOMER_PORT" "partner:$PARTNER_PORT" "api:$API_PORT"; do
  role="${pp%%:*}"; port="${pp##*:}"
  C="$(code "http://${HOST}:${port}/")"
  if [ "$C" = "502" ] || [ "$C" = "000" ]; then
    fail "L3 ${role} http://${HOST}:${port}/ -> ${C}" \
         "preview for '${BUG}' not up on this port, or born with a different PREVIEW_IP. On the box: preview.mjs list; then PREVIEW_IP=${IP} preview.mjs up ${BUG^^} <worktree>"
  else
    pass "L3 ${role} http://${HOST}:${port}/ -> ${C}"
  fi
done

echo "Done. All PASS ⇒ open http://${HOST}:${CUSTOMER_PORT}/ (customer) or :${PARTNER_PORT}/ (partner)."
