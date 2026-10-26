#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # check() evals assertions late by design
#
# Tests for .github/scripts/deploy-launch-notify.sh (ENG-2677).
# Run with:  bash .github/scripts/deploy-launch-notify.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/deploy-launch-notify.sh"
TDIR="$(mktemp -d)"
trap 'rm -rf "${TDIR}"' EXIT
FAILED=0
check() { if eval "$2"; then echo "ok - $1"; else echo "FAIL - $1"; FAILED=1; fi; }

# shellcheck source=/dev/null
LAUNCH_NOTIFY_LIB=1 source "${SCRIPT}"
set +e

# Multiple PRs: sorted, ENG ids from title+body, deduped, run URL last.
cat >"${TDIR}/multi.json" <<'EOF'
[
 {"number": 12, "title": "Fix GA4 sync retries", "body": "Refs ENG-102\nalso ENG-102"},
 {"number": 11, "title": "feat: Meta pacing (ENG-101)", "body": "Closes ENG-105"},
 {"number": 13, "title": "No ticket here", "body": null}
]
EOF
out="$(build_launch_message "${TDIR}/multi.json" "https://run/1")"
check "multi: header" '[[ "$out" == "Shipped to production (backend):"* ]]'
check "multi: sorted, ids merged" 'grep -qxF -- "- #11 feat: Meta pacing (ENG-101) (ENG-101, ENG-105)" <<<"$out"'
check "multi: dedup id" 'grep -qxF -- "- #12 Fix GA4 sync retries (ENG-102)" <<<"$out"'
check "multi: no id -> bare" 'grep -qxF -- "- #13 No ticket here" <<<"$out"'
check "multi: order" '[ "$(grep -n "#11" <<<"$out" | cut -d: -f1)" -lt "$(grep -n "#13" <<<"$out" | cut -d: -f1)" ]'
check "multi: run url last" '[ "$(tail -n1 <<<"$out")" = "https://run/1" ]'

# Zero PRs -> empty text -> no post.
echo '[]' >"${TDIR}/empty.json"
out="$(build_launch_message "${TDIR}/empty.json" "https://run/1")"
check "zero PRs: no message" '[ -z "$out" ]'

# Shell metacharacters stay literal data, never evaluated.
cat >"${TDIR}/meta.json" <<'EOF'
[{"number": 9, "title": "x $(touch PWNED) `id` ; rm -rf / && echo \"q\"", "body": ""}]
EOF
( cd "${TDIR}" && build_launch_message meta.json "u" >meta.out )
check "metachar: title verbatim" 'grep -qF -- "- #9 x \$(touch PWNED) \`id\` ; rm -rf / && echo \"q\"" "${TDIR}/meta.out"'
check "metachar: nothing executed" '[ ! -e "${TDIR}/PWNED" ]'

# Unset channel -> skipped with notice, exit 0, before any network/aws use.
out="$(FEATURE_LAUNCHES_CHANNEL='' BASE_SHA=abc bash "${SCRIPT}" 2>&1)"; rc=$?
check "unset channel: exit 0" '[ "$rc" -eq 0 ]'
check "unset channel: notice" 'grep -q "LAUNCH_NOTIFY_SKIPPED" <<<"$out"'

# Unresolved base -> skipped, exit 0.
out="$(FEATURE_LAUNCHES_CHANNEL=C1 BASE_SHA='' bash "${SCRIPT}" 2>&1)"; rc=$?
check "no base: exit 0 + notice" '[ "$rc" -eq 0 ] && grep -q "LAUNCH_NOTIFY_SKIPPED" <<<"$out"'

# Slack ok:false -> step fails (non-zero). Mock git/gh/aws/curl on PATH.
mkdir -p "${TDIR}/bin"
cat >"${TDIR}/bin/git" <<'M'
#!/usr/bin/env bash
printf 'Merge pull request #42 from o/b\nfeat: a thing (#41)\nMerge branch main into x\n'
M
cat >"${TDIR}/bin/gh" <<'M'
#!/usr/bin/env bash
echo "{\"number\":$3,\"title\":\"t$3\",\"body\":\"ENG-1\"}"
M
cat >"${TDIR}/bin/aws" <<'M'
#!/usr/bin/env bash
echo '{"botToken":"xoxb-test"}'
M
cat >"${TDIR}/bin/curl" <<'M'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done
printf '%s' "${MOCK_SLACK_BODY}" >"$out"; printf '200'
M
chmod +x "${TDIR}/bin/"*
run_full() {
  env -u GITHUB_ACTIONS PATH="${TDIR}/bin:${PATH}" MOCK_SLACK_BODY="$1" FEATURE_LAUNCHES_CHANNEL=C1 \
    BASE_SHA=a COMMIT_SHA=b REPO=o/r RUN_URL=u bash "${SCRIPT}" 2>&1
}
out="$(run_full '{"ok":false,"error":"not_in_channel"}')"; rc=$?
check "ok:false: fails loudly" '[ "$rc" -ne 0 ] && grep -q "not_in_channel" <<<"$out"'
check "ok:false: token not printed" '! grep -q "xoxb-test" <<<"$out"'
out="$(run_full '{"ok":true}')"; rc=$?
check "ok:true: exit 0" '[ "$rc" -eq 0 ] && grep -q "2 PR" <<<"$out"'

exit "${FAILED}"
