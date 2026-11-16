#!/usr/bin/env bash
#
# ENG-2637: draft a same-day #feature-launches rollout note.
#
# Lists PRs merged to main on DATE (UTC, default today) that are covered by a
# successful production Deploy run that day (run started at/after the merge),
# drops dependabot / chore / docs-only PRs, and prints a plain-text DRAFT.
# It never posts to Slack -- posting stays a human action (ENG-2634).
#
# Usage: REPO=AgentWebPro/agentweb [DATE=YYYY-MM-DD] [OUT=file] bash rollout-note.sh
# Exit: 0 = draft written (or empty day: no output, nothing written), 2 = gh failure.

set -euo pipefail

REPO="${REPO:-AgentWebPro/agentweb}"
DATE="${DATE:-$(date -u +%F)}"
OUT="${OUT:-}"

prs="$(gh pr list --repo "${REPO}" --state merged --base main --limit 200 \
  --search "merged:${DATE}" \
  --json number,title,author,body,mergedAt,labels,files)" || exit 2

runs="$(gh run list --repo "${REPO}" --workflow deploy.yml --branch main \
  --status success --limit 100 --json createdAt)" || exit 2

# Latest successful deploy start time on DATE; PRs merged at/before it shipped.
last_deploy="$(jq -r --arg d "${DATE}" \
  '[.[] | select(.createdAt | startswith($d)) | .createdAt] | max // ""' <<<"${runs}")"
[ -n "${last_deploy}" ] || exit 0

note="$(jq -r --arg cut "${last_deploy}" '
  def docs_only: (.files // []) as $f | ($f | length) > 0 and
    ($f | all(.path | test("(\\.md$)|(^docs/)|(^dev/pending/)")));
  def skip: (.author.login | test("dependabot"))
    or (.title | test("^(chore|docs)(\\(|:|!)"; "i"))
    or docs_only;
  # A summary is the first sentence of prose. Markdown headings, the Reviewer-First
  # "Risk: ... | Priority: ..." header, bare heading words, issue links and HTML
  # comments are structure. When the body has a "What this fixes" section, the
  # sentence under it is the summary: the section before it describes the bug.
  def clean: gsub("^[#>*\\- ]+"; "") | gsub("\\*\\*|`"; "") | gsub("\\s+$"; "");
  def structural: test("^\\s*#{1,6}(\\s|$)") or test("^\\s*<!--")
    or (clean | (length == 0
      or test("^(summary|what|why|how)(\\s*[/&,]\\s*(summary|what|why|how))*:?$|^(Closes|Fixes|Refs)\\b|^Risk:\\s|^Linear[- ]issue\\b"; "i")));
  def first_prose: [ .[] | select(structural | not) | clean ][0];
  def summary: ((.body // "") | split("\n") | map(sub("\\r$"; ""))) as $lines
    | ($lines | map(test("^\\s*#{1,6}\\s*what this fixes"; "i")) | index(true)) as $fix
    | ((if $fix == null then null else ($lines[$fix + 1:] | first_prose) end)
       // ($lines | first_prose) // "") | .[0:200];
  # Issue id: the title names the issue the PR belongs to; failing that a "Linear-Issue:" /
  # "Linear issue" line does; a bare mention in the body may be an unrelated issue.
  def eng_id: ([.title | match("ENG-[0-9]+"; "g").string][0])
    // ([(.body // "") | match("linear[- ]issue:?[ \\t*#]*\\r?\\n?[ \\t]*(ENG-[0-9]+)"; "gi").captures[0].string][0])
    // ([(.body // "") | match("ENG-[0-9]+"; "g").string][0])
    // "no ENG id";
  [ .[] | select(.mergedAt <= $cut) | select(skip | not) ]
  | sort_by(.mergedAt)
  | map("- " + .title
        + " (" + eng_id
        + ", @" + .author.login + ", #" + (.number | tostring) + ")"
        + (summary as $s | if $s == "" then "" else "\n  " + $s end))
  | join("\n")' <<<"${prs}")"

[ -n "${note}" ] || exit 0

draft="DRAFT #feature-launches rollout note for ${DATE} (not posted; review then post):

${note}"

if [ -n "${OUT}" ]; then printf '%s\n' "${draft}" >"${OUT}"; fi
printf '%s\n' "${draft}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo '```'; printf '%s\n' "${draft}"; echo '```'; } >>"${GITHUB_STEP_SUMMARY}"
fi
