## ENG-1103: route-level authz tests for orphaned org join-request diagnostic (2026-10-07)

Adds `adminOrgDiagnostics.route.test.ts`: unauthenticated 401, non-admin and delegated 403 with no scan, admin 200 breakdown, generic 500, no mutating verbs. Closes AC4 authorization-denied coverage; no runtime change.
