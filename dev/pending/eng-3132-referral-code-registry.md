## ENG-3132: Zoma referral-code registry, slice A (2026-11-18)

`signupRef` (ENG-2906) is a free-form label, not a referrer. This slice adds `services/zomaReferralRegistry.ts`: a registry of referral codes so that only a registered, active code can earn commission. Nothing calls it yet; accrual and the payout ledger come in later slices behind `ZOMA_REFERRAL_ENABLED`.

- **Data-plane:** new table `AW-ZomaReferralCodes` (PK `code`, no sort key, no GSI, pay-per-request, deletion protection, point-in-time recovery attempted non-fatally), defined in `scripts/create-tables.ts`. Anurag approved the table; Yugo creates it after review. Until it exists nothing reads or writes it.
- **Rules:** a code is a valid `ref` (`/^[a-z0-9_-]{1,64}$/`, lowercase only because ENG-2906 drops uppercase refs), at least 4 characters, and never a launch-channel alias (`classifyAcquisitionSource` would file it under that channel) or a reserved word. Codes are never overwritten; revoking is idempotent and keeps the first revocation time.
- **Resolution:** `resolveReferrer(signupRef)` returns `none` (unregistered or malformed), `revoked`, or `active`. A store outage throws, so accrual cannot mistake an outage for "not a referral".
- **Config (env, defaults dark):** `ZOMA_REFERRAL_ENABLED` (exact `true`), `ZOMA_REFERRAL_PERCENT` (default 20, up to 2 decimals, stored as basis points), `ZOMA_REFERRAL_MONTHS` (default 3, 1 to 12). A per-code percent override is supported.
- **Rollback:** unused code; reverting leaves no stored data. If the table was created, it can stay empty.
