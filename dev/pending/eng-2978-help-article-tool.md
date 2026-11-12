## ENG-2978: Zoma ads_get_help_article parity tool (2026-11-12)

- Added a pure, read-only `ads_get_help_article` toolkit lookup with a conservative two-entry official Meta documentation index and one-line summaries. Supports normalized topic aliases and diagnostics error codes/subcodes; unknown queries return an explicit no-curated-article result.
- Registered the tool in the Meta manifest and account-free gateway path, marked its annotations read-only, and closed its parity matrix gap. No provider requests, account access, writes, or generated URLs.
- Verification: 39 tests passed across ENG-2978, ENG-2921, and ENG-2950 (3 suites), including host allowlisting, unknown inputs, scope enforcement, metering, and no-account/no-write behavior. Scoped TypeScript check passed for help lookup, annotations, and parity matrix plus their imported dependencies.
- Not tested: live Meta endpoints, full repository typecheck/build, production smoke. Jest reports existing open handles and requires forced exit.
- Risk: small static index intentionally does not cover every topic. Rollback: revert this change; no data migration or state cleanup required. Post-deploy smoke: list tools, then call `ads_get_help_article` with `topic: rate limiting` and an unknown topic; verify official URL versus empty articles.
