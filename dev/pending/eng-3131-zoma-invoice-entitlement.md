## ENG-3131: Require invoice settlement for Zoma publish entitlement (2026-11-16)

Stacked follow-up to the Zoma billing implementation (#4156). A Stripe subscription in `trialing` or `active` is not sufficient evidence of a paid invoice. Expand the latest invoice and require its paid status before publishing. An unsettled otherwise-live plan returns a pending-payment response rather than another subscription checkout, and `zoma_status` no longer marks that plan as ready.

Design and unresolved launch gates: `docs/zoma-payments-design.md`. Billing remains dark behind `ZOMA_BILLING_ENABLED`; no deployment, prices, live charges or ad operations were performed. Five scoped Jest suites passed (128 tests); inherited rate-limiter intervals require Jest force exit. Scoped TypeScript with a 2.5 GiB heap still exhausted memory through transitive imports, so typecheck is not proven locally. The requested Bookface post remains inaccessible without a YC login.
