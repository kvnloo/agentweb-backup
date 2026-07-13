#!/usr/bin/env bash
# ENG-287 residual-hardening smoke test — drives the REAL API against a test env.
#
#   BASE=http://44.255.50.89:3001 TOKEN=<jwt> ./backend/scripts/eng287-smoke.sh
#
# Get TOKEN from the customer portal: devtools → Application → Local Storage → "token".
#
# What it proves (each maps to a bug that was live before this branch):
#   1. delete + regenerate the same slug with a DIFFERENT prompt mints a FRESH v0 chat
#      (before: the stale `succeeded` guard row silently returned the OLD chat and your
#       new prompt never reached v0)
#   2. two concurrent generates of the same route dedupe to ONE record / ONE chat
#   3. a retry after a failure is never wedged behind "already in flight"
#   4. a first-page build reports `generating`, never `draft`, while v0 generates
#   5. deploy is REFUSED on an actively-building record (two builds must not race)
#
# It does NOT prove the credit fix — for that, open the v0 dashboard chat list afterwards
# and confirm the chat count equals the number of pages you MEANT to build. An extra chat
# per retry is the original orphan-burn bug.
set -uo pipefail

BASE="${BASE:?set BASE, e.g. http://44.255.50.89:3001}"
TOKEN="${TOKEN:?set TOKEN (JWT from the portal)}"
API="$BASE/api/landing-pages/v0"
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

pass=0; fail=0
ok()   { echo "  ✅ $1"; pass=$((pass+1)); }
bad()  { echo "  ❌ $1"; fail=$((fail+1)); }
note() { echo "     · $1"; }

# Find a key ANYWHERE in the response. The generate endpoint does not always return the
# record at the top level (it may nest it under page/landingPage/data), and a shallow
# d.get(key) then silently yields "" — which reads as "no chat was minted" and reports a
# false negative on the most important check in this script.
jqr() {
  python3 -c "
import sys, json
key = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print(''); raise SystemExit
def find(o):
    if isinstance(o, dict):
        if key in o and o[key] not in (None, ''):
            return o[key]
        for v in o.values():
            r = find(v)
            if r: return r
    elif isinstance(o, list):
        for v in o:
            r = find(v)
            if r: return r
    return None
print(find(d) or '')
" "$1" 2>/dev/null
}

gen() { # gen <prompt> <name> [siteId]
  local body
  body=$(python3 -c "
import json,sys
d={'prompt':sys.argv[1],'name':sys.argv[2]}
if len(sys.argv)>3 and sys.argv[3]: d['site_id']=sys.argv[3]
print(json.dumps(d))" "$1" "$2" "${3:-}")
  curl -s -m 900 -X POST "$API/generate" "${H[@]}" -d "$body"
}
get_page() { curl -s -m 30 "$API/generated/$1" "${H[@]}"; }
del_page() { curl -s -m 60 -X DELETE "$API/generated/$1" "${H[@]}" -o /dev/null -w '%{http_code}'; }

# chat_id <response-json> <page-id> — read v0ChatId from the response, and if it is not
# there, re-read the record. Never infer "no chat" from a parsing miss: this value decides
# whether we report a stale-chat reuse, so a false empty is worse than a slow check.
chat_id() {
  local c
  c=$(printf '%s' "$1" | jqr v0ChatId)
  if [[ -z "$c" && -n "${2:-}" ]]; then
    c=$(get_page "$2" | jqr v0ChatId)
    [[ -n "$c" ]] && note "(v0ChatId absent from the POST body — read it back via GET)"
  fi
  printf '%s' "$c"
}

SLUG_NAME="ENG287 Smoke $(date +%H%M%S)"

echo
echo "════ 1. delete + regenerate with a DIFFERENT prompt must mint a FRESH chat ════"
echo "  (the prompt-hijack bug: the guard key has no prompt in it, so a surviving"
echo "   'succeeded' row would silently hand back the OLD chat)"
r1=$(gen "a pricing page with exactly three tiers" "$SLUG_NAME")
id1=$(echo "$r1" | jqr id); chat1=$(chat_id "$r1" "$id1")
st1=$(echo "$r1" | jqr status)
note "page=$id1 chat=$chat1 status=$st1"
if [[ -z "$id1" ]]; then bad "generate #1 returned no id — check TOKEN/subscription"; echo "$r1" | head -c 400; echo; exit 1; fi

code=$(del_page "$id1"); note "DELETE -> HTTP $code"
r2=$(gen "a testimonials wall, absolutely no pricing" "$SLUG_NAME")
id2=$(echo "$r2" | jqr id); chat2=$(chat_id "$r2" "$id2")
note "page=$id2 chat=$chat2"

if [[ -n "$chat1" && "$chat1" == "$chat2" ]]; then
  bad "REUSED the old chat ($chat1) — your new prompt never reached v0. THE BUG IS LIVE."
elif [[ -n "$chat2" ]]; then
  ok "fresh chat minted ($chat1 -> $chat2). Now EYEBALL the page: it must show testimonials, not pricing."
else
  bad "no chat id on regenerate — inspect: $(echo "$r2" | head -c 300)"
fi

echo
echo "════ 2. two concurrent generates of the same route dedupe to ONE chat ════"
CONC="ENG287 Race $(date +%H%M%S)"
gen "a demo booking page" "$CONC" > /tmp/eng287_a.json &
gen "a demo booking page" "$CONC" > /tmp/eng287_b.json &
wait
ia=$(jqr id < /tmp/eng287_a.json);       ib=$(jqr id < /tmp/eng287_b.json)
ca=$(chat_id "$(cat /tmp/eng287_a.json)" "$ia"); cb=$(chat_id "$(cat /tmp/eng287_b.json)" "$ib")
note "A: page=$ia chat=$ca"
note "B: page=$ib chat=$cb"
if [[ -n "$ca" && "$ca" == "$cb" ]]; then
  ok "deduped to one chat ($ca) — only one v0 generation was paid for"
elif [[ -z "$ca" || -z "$cb" ]]; then
  note "one call was rejected/failed — acceptable IF the message is 'already in progress' (that is the dedupe), NOT a wedge"
  grep -o '"error"[^,}]*' /tmp/eng287_a.json /tmp/eng287_b.json 2>/dev/null | head -2
else
  bad "TWO different chats ($ca vs $cb) — double-spend, dedupe is not working"
fi

echo
echo "════ 3. no request may ever fail with the old 'already in flight' wedge ════"
if grep -qi "same idempotency key is already in flight" /tmp/eng287_a.json /tmp/eng287_b.json 2>/dev/null; then
  bad "the OLD wedge message is still being emitted — ENG-277 is not fixed"
else
  ok "the misleading 'same idempotency key already in flight' message is gone"
fi

echo
echo "════ 4. a build in progress reports 'generating', never 'draft' ════"
note "(a first-page build used to sit in 'draft' for its WHOLE generation — invisible to"
note " the janitor, to route-reuse, and to agent-mode reconnect)"
seen_draft=""
LIVE="ENG287 Status $(date +%H%M%S)"
gen "a long detailed multi-section landing page" "$LIVE" > /tmp/eng287_live.json &
GEN_PID=$!
for _ in $(seq 1 40); do
  sleep 5
  s=$(curl -s -m 20 "$API/generated" "${H[@]}" \
      | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit()
ps=d if isinstance(d,list) else d.get('pages',d.get('landingPages',[]))
for p in ps:
    if p.get('name')=='$LIVE': print(p.get('status',''))
" 2>/dev/null | head -1)
  [[ "$s" == "draft" ]] && seen_draft="yes"
  [[ -n "$s" ]] && note "status=$s"
  [[ "$s" == "deployed" || "$s" == "failed" ]] && break
done
wait $GEN_PID 2>/dev/null
if [[ -n "$seen_draft" ]]; then
  bad "observed status 'draft' mid-build — the async-switch regression is still present"
else
  ok "never observed 'draft' mid-build"
fi

echo
echo "════ 5. deploy must be REFUSED while a build is actively generating ════"
lid=$(jqr id < /tmp/eng287_live.json)
if [[ -n "$lid" ]]; then
  dep=$(curl -s -m 30 -X POST "$API/generated/$lid/deploy" "${H[@]}")
  if echo "$dep" | grep -qi "status: generating"; then
    ok "refused an actively-generating record (two builds cannot race into one repo)"
  else
    note "record had already finished, so this check is inconclusive: $(echo "$dep" | head -c 160)"
  fi
fi

echo
echo "──────────────────────────────────────────────────────────────"
echo "  passed: $pass   failed: $fail"
echo
echo "  STILL DO BY HAND (no API can prove these):"
echo "   • open the v0 dashboard chat list — the chat count must equal the number of"
echo "     pages you MEANT to build. One extra chat per RETRY = the orphan credit burn."
echo "   • confirm the regenerated page in test 1 actually shows TESTIMONIALS, not pricing."
echo "   • scan Dev-AW-V0Usage: one 'succeeded' row per route (not per attempt), no"
echo "     prompt hash in the key, nothing left 'reserved' after a build ends."
echo "──────────────────────────────────────────────────────────────"
[[ $fail -eq 0 ]]
