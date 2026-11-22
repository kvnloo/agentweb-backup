# Cross-tenant IDOR probe (post-merge verifier)

ENG-2419 (parent ENG-2405). `.github/scripts/idor-probe.sh` calls
`POST /api/domains/custom` as tenant B against a project owned by tenant A and
requires HTTP 403. The 403 path returns before any Vercel call (ENG-2403), so
a healthy deployment has no side effects.

Fixture env (all required):

- `IDOR_API_BASE` — API origin
- `TENANT_A_TOKEN`, `TENANT_B_TOKEN` — bearer tokens for two test users in different orgs
- `FIXTURE_PROJECT_ID` — a `vercelProjectId` owned by tenant A
- optional `IDOR_PROBE_DOMAIN` (default `idor-probe.invalid`)

Exit codes: `0` PASS (403) · `1` FAIL (2xx = IDOR, anything else = inconclusive)
· `3` SKIPPED_NO_FIXTURE. Exit 3 is never verification evidence; record it as
"not verified" in the post-merge comment, same as merge-evidence `NO_EVIDENCE`.

Provisioning the prod tenants/tokens is gated on Harsha's decision in ENG-2405.
Until then the probe reports SKIPPED_NO_FIXTURE.
