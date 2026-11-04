# Publish-gate verifier fixture (ENG-1496)

Lifecycle, isolation, cleanup and cost limits for the landing page that the post-merge
publish-gate verifier uses. Parent: ENG-1496. Harness: ENG-1496.1 / ENG-2794
(`backend/src/services/publishGateVerifier.ts`). Cleanup selector: ENG-1496.2 / ENG-2795
(`backend/src/services/publishGateVerifierCleanup.ts`).

## Owning account

- One dedicated AgentWeb organization owns the fixture (the "verifier org"). It is internal,
  has no billing plan, no customer users, and no custom domain.
- Every fixture page carries the tag `publish-gate-verifier`. The verifier and the cleanup
  selector both refuse to touch a page without that tag; cleanup also refuses any page outside
  the verifier org, even if it is tagged.

## Isolation from customers

- No customer org ID, domain, pixel, CRM or ad account is referenced by the fixture.
- The fixture page is served only on its platform preview host, never on a customer domain.
- Draft branches are named `verifier/publish-gate-<run-id>` so cleanup can match them by prefix
  without ever matching `main` or a customer draft branch.

## Draft-branch setup (one run)

1. Create `verifier/publish-gate-<run-id>` from the fixture repo's `main`.
2. Commit a trivial change and note the exact SHA.
3. Run the harness (`runPublishGateVerifier` from ENG-2794) against that SHA. In CI the check
   client is mocked; a live run reads GitHub check runs read-only and only publishes when the
   exact-SHA `Tests` check has passed.
4. If publish throws, the harness calls `rollback` to restore the previous `main` ref.

## Cleanup

1. Load candidate pages from the verifier org.
2. Call `planVerifierCleanup(pages, { fixtureOrganizationId })`. The result is always a dry-run
   plan (`dryRun: true`) listing page IDs and `verifier/publish-gate-*` branches to delete.
   Pages younger than 24h, or with no creation date, are skipped so an in-flight run is not cut.
3. A human (or a later reviewed script) performs the deletes from the plan. This module never
   deletes anything.

## Cost ceiling

- At most one fixture page and one live run per day; at most 5 retained draft branches.
- No paid ads, no custom-domain certificates, no LLM generation in the verifier path.
- Expected spend is GitHub Actions minutes for one `Tests` run per verification. If a run would
  exceed 10 Actions minutes or the fixture count exceeds 5, stop and file an ENG issue instead
  of continuing.
