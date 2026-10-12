## ENG-2403: domain-attach writes require project ownership (2026-10-12)

- `POST /api/domains/custom` and `/subdomain` now 403 (before any Vercel call) unless the caller owns, or has org edit rights (`canUserEditLandingPage`) to, a landing page whose `vercelProjectId` matches the body. Lookup errors fail closed.
- Test: `backend/src/__tests__/routes.domains.test.ts` (ENG-2403 block).
