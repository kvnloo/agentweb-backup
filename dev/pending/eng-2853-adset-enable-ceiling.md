## ENG-2853: Spend ceiling on ad set/ad group enable (2026-11-07)

- Google ad-group enable resolves its provider parent campaign and budget, applies the same ceiling/refusal as campaign enable, and binds approval to that budget state.
- Meta ad-set activation checks its current daily budget (or its provider-resolved campaign daily budget for campaign-budgeted sets), refusing over-ceiling or unreadable budgets before dispatch. Approval is bound to the resolved budget state and rechecked at confirmation.
- Existing configured global policies and units are unchanged; no schema, persistence, or durable confirm tokens added. Lifetime-only budgets with no evaluable daily budget fail closed when a ceiling is configured.
- Verification: 106 tests passed in five scoped Jest suites, including 12 new acceptance tests. Scoped pure guard/seam/ceiling TypeScript check passed. Full backend type check exhausted a 3 GiB heap; no full type-check success claimed. Jest reports an existing worker teardown/open-timer warning.
- Not tested: live provider writes, production deployment, full test suite. Rollback: revert this commit. Post-deploy smoke: preview an over-ceiling and under-ceiling child enable on each provider without confirming; expect refusal and PREVIEW respectively.
