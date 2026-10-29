## ENG-2758: Scheduled chat defers OpenRouter key-limit/credits exhaustion to reset (2026-10-29)

- New pure classifier `backend/src/utils/openRouterKeyLimit.ts` recognises OpenRouter 403 "Key limit exceeded" and 402 credits errors and parses `resets <ISO>`.
- Zero-output scheduled runs hitting it are deferred to the reset (or next natural occurrence), schedule stays active, no zero-output retry spent.
- Auto-issue filing carries `Alert Class: openrouter-quota-exhausted` (one canonical across schedules); oncall dedupe key is class-wide.
