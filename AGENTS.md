# AgentWeb Agent Instructions

This repo inherits Harsha's global Codex development rules. Keep repo-local
instructions narrow and operational.

## Shipping

- When shipping a normal PR from this repo, enable GitHub auto-merge once local
  checks and required GitHub checks are green.
- If auto-merge is blocked by a stale branch, merge queue state, or sync issue,
  update the branch, rerun checks, and confirm auto-merge is armed.
- Do not manually press merge to `main`; use GitHub auto-merge for shippable
  PRs.
- Keep high-risk, draft, blocked, auth, billing, security, data deletion, and
  production-infra changes out of auto-merge until Harsha explicitly clears
  them.
