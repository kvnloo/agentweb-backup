## ENG-3212: Built-in default spend ceiling for Google and X Toolkit writes (2026-11-27)

**Problem:** Prod EB is at CloudFormation's 4096-char `EnvironmentVariables` limit, so
`GOOGLE_TOOLKIT_SPEND_CEILING` and `X_ADS_TOOLKIT_SPEND_CEILING` were never set on prod. Unset
meant "no ceiling", so external Zoma agents' Google/X budget writes had no spend limit.

**Fix:** `googleSpendCeilingPolicyFromEnv` (`backend/src/mcp/googleToolkitWrites.ts`) now returns
`DEFAULT_GOOGLE_X_SPEND_CEILING` = `{maxDailyBudget: 500_000_000, maxChangeRatio: 2}` (micros:
$500/day, at most 2x per change) when the env var is unset or empty, mirroring
`DEFAULT_LINKEDIN_SPEND_CEILING`. A set env var fully replaces the default; malformed JSON still
fails closed (`{maxChangeRatio: -1}` → every money write refused).

**Also fixed:** `raw` used to default to `process.env.GOOGLE_TOOLKIT_SPEND_CEILING`, and X passes
`process.env.X_ADS_TOOLKIT_SPEND_CEILING` — when X's var was unset that `undefined` triggered the
default parameter, so X silently inherited Google's ceiling. `raw` is now a required argument;
each provider reads only its own env var.

**Raise a limit:** set the provider's env var (micros JSON, e.g. `{"maxDailyBudget":1000000000}`).
Note a set value replaces the default entirely, so include `maxChangeRatio` if you still want it.

Tests: `backend/src/__tests__/eng3212.googleXDefaultCeiling.test.ts`.
