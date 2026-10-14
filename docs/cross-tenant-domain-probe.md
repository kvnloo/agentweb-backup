# Cross-tenant custom-domain probe (ENG-2411 / ENG-2405)

Post-merge check that the ENG-2403 ownership guard still refuses a tenant
attaching a domain to another tenant's Vercel project.

## Run

    cd backend
    XTENANT_API_BASE=https://<api-host> \
    XTENANT_B_TOKEN=<tenant B bearer> \
    XTENANT_A_VERCEL_PROJECT_ID=<project owned by tenant A> \
    npx ts-node src/verification/crossTenantDomainProbe.ts

Optional: `XTENANT_PROBE_DOMAIN` (default `eng-2405-xtenant-probe.invalid`).

## Verdicts

- PASS (exit 0): HTTP 403 — guard refused before any Vercel call.
- FAIL (exit 1): 2xx means a cross-tenant write was accepted (treat as a
  security incident: remove the domain from A's project, revert the deploy).
  Any other status means the guard is unproven (401 = bad B token).
- SKIP (exit 2): fixtures not configured. SKIP is not evidence.

## Fixtures

The two tenants, A's fixture project, and where B's token is stored are gated
on Harsha's decision in ENG-2405. This probe does not create them.
