# AgentWeb Agent Instructions

This repo inherits Harsha's global Codex development rules. Keep repo-local
instructions narrow and operational.

## Shipping

- AI agents own execution through merge for qualifying engineering work. A PR
  merges without routine human approval only when it is current with `main`,
  the affected production build passes, every relevant GitHub check is green,
  attribution is valid, rollback/post-deploy verification is defined, and the
  PR is complete against its acceptance contract. Routine product-test suites,
  coverage targets, and PR staging deploys are not merge gates.
- Atem is the test compute plane when a test is warranted. Retain or add a test
  only for a human acceptance criterion, a critical invariant (auth, security,
  billing, or data integrity), deploy-control integrity, or a reproduced
  production regression. Do not update tests merely to bless an implementation;
  stale, flaky, or low-signal tests may be removed with a recorded reason.
- Greptile is retired (ENG-1371, 2026-08-19). It is no longer a merge
  criterion, and the `Require Greptile Review` job, its scripts and
  `greptile.json` are deleted from both repos. Do not wait for a Greptile
  verdict — none will arrive. CodeRabbit still comments on every PR and is
  advisory only: it has never been a required check and reports `pass`
  regardless of its own rate-limit state, so read its findings, but nothing
  mechanical gates on it. This mirrors the same change in CLAUDE.md; the two
  files must not disagree about what gates a merge.
- Prove "every relevant GitHub check is green" with
  `REPO=AgentWebPro/agentweb PR_NUMBER=<n> bash .github/scripts/merge-evidence.sh`
  (exit 0), not with `gh pr checks` alone. That command answers "did anything
  fail", and skipped is not failed, so it exits 0 both on a conflicted PR — which
  cannot schedule a run at all — and on a stale draft-time run in which every job
  skipped. Exit 3 is `NO_EVIDENCE`, meaning nothing has ever executed against
  this head; it is not a pass and never satisfies the gate (ENG-757).
- Prefer the repository's configured GitHub auto-merge mechanism. If merge is
  blocked by a stale branch, merge queue state, flaky gate, or sync issue, fix
  that condition, rerun the affected gates, and merge once the latest head is
  proven green. Never normalize "rerun until green."
- Database/data-plane changes require Harsha's explicit pre-merge approval:
  migrations; table, schema, index, key, ORM/persistence-model changes;
  backfills, bulk mutations, deletes, production data repair; persistence
  provisioning, retention, backup/restore, encryption, or access-policy
  changes; and anything that can reinterpret, orphan, expose, or make stored
  data unrecoverable.
- Auth, billing, security, and production-infrastructure code are not routine
  human merge holds merely by domain. Require stronger invariants, negative
  tests, blast-radius and rollback evidence, then merge on the full gate unless
  the change crosses the database/data-plane boundary.
- Material customer, sales, marketing, social, or press copy that Harsha has
  not reviewed stops before publish/merge. Applying already-approved copy
  mechanically is not a second review gate.
- A missing or failing test, evaluator, CI job, staging check, deployment check,
  attribution check, or monitor is a pipeline defect to repair—not a reason to
  add a permanent human approval.
- Merging to `main` triggers the path-filtered production deployment. Observe
  the deployment and run the PR's post-deploy smoke. Agents never set Linear
  `Done`; customer-communication state remains human-controlled.
- Prefer `coderabbit review` locally (CLI, authenticated, see `.coderabbit.yaml`)
  before opening a PR. Local review draws from a separate rate-limit bucket
  from the PR-stage review, so a pass or two here catches issues without
  spending PR-stage quota or triggering a CI re-run. This is a recommendation,
  not a gate — CodeRabbit remains advisory only (see above).
- Test ownership is mid-shift toward CodeRabbit (Phase 1: it generates/reviews
  unit tests and runs a warning-only pre-merge check; Phase 2, gated on proof,
  would make it a real merge gate and drop Jest from required checks — not
  done yet). Global doctrine + Phase 2 criteria: `~/.claude/rules/coderabbit-
  test-ownership.md`. Do not treat this repo's `.coderabbit.yaml` as already
  in Phase 2 — GitHub Actions' Jest suite is still the real gate.

## Business execution

- For OPS, GROW, Sales, Marketing, and CS work, invoke Emma directly wherever
  the required capability exists and verify the result end to end.
- Emma owns research, analysis, CRM/list work, reporting, reversible operations,
  work inside an existing approved budget, and complete drafts. Harsha reviews
  judgment-bearing external copy before send/publish and handles new or
  unbounded spend, legal commitments, and credentials only he can grant.
- If Emma lacks a capability, use another authorized AI/tool when safe and file
  one deduplicated Emma capability gap. Do not turn Harsha into the recurring
  operator.
