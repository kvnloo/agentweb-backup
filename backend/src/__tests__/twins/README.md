# Arga twin test suites (ENG-401 / ENG-402 · OPS-8)

Opt-in integration suites that exercise our real Stripe / Slack seams against a
**live Arga twin** — a faithful fake of the third-party API that keeps real state
and returns real response/error shapes. They are **never a required check** and
are excluded from the default `npm test` run (jest.config.js
`testPathIgnorePatterns` skips `/__tests__/twins/`).

## The reusable-twin workflow

Per Arga founder Akira's guidance: **provision one twin, reuse it, reset it to
baseline between tests** — do NOT provision a fresh twin per test (that burns the
free monthly quota fast). The flow is three steps:

```bash
# 1. Once per working session — provisions ONE session (slack + stripe) and
#    writes backend/.env.twins.json (gitignored). Needs Arga quota.
npm run test:twins:setup

# 2. Repeatedly — reads .env.twins.json, points our seams at the twin, and
#    resets the twin to its baseline seed state before EACH test for isolation.
npm run test:twins
#    (filter one suite: npm run test:twins -- --testPathPattern=slack)

# 3. When done — tears the session down and removes .env.twins.json.
npm run test:twins:teardown
```

If `.env.twins.json` is absent, `npm run test:twins` **skips cleanly** with a
message pointing you at `test:twins:setup` — a dev without a twin is never
blocked.

### Config file shape (`backend/.env.twins.json`, gitignored)

```json
{
  "runId": "<provision run_id>",
  "twins": {
    "stripe": { "baseUrl": "https://…" },
    "slack": {
      "baseUrl":  "https://…",
      "adminUrl": "https://…",
      "proxyToken": "<admin JWT>",
      "botToken":  "xoxb-…"
    }
  }
}
```

Override the path with `ARGA_TWIN_CONFIG=/path/to/file.json`. The setup script's
scenario preset is overridable with `ARGA_TWIN_SCENARIO_ID`, TTL with
`ARGA_TWIN_TTL`, and the CLI binary with `ARGA_BIN`.

## Honest free-tier reality (read before you rely on this)

- **Free plan = 10 ephemeral twin runs / month, ~10-minute TTL each.** The twin
  is *not* long-lived: it expires ~10 minutes after `setup`. So "reuse" means
  reuse **within one working session** — re-run `test:twins:setup` at the start of
  each session. The teardown/setup pair spends **one** run from the monthly quota
  per session, not one per test.
- **Quota is shared across all twins and metered per provision.** Provisioning a
  `slack,stripe` session in one call is one run, which is exactly why we bundle
  both services into a single session instead of two.
- A **true long-lived permanent twin** ("long-running scenario agents" that stay
  up across sessions) is an Arga **Team** feature — not available on free. If we
  need a persistent shared twin for CI, that is the upgrade path.
- Because provisioning is quota-gated, `test:twins:setup` runs a quota/auth
  pre-flight (`arga whoami`) and **fails loud** with a clear message when the
  monthly quota is exhausted, rather than emitting a raw 403.

## Files

| File | Role |
|---|---|
| `twinSession.ts` | Config load + `getTwin` + `resetTwinToBaseline` + skip resolver + quota pre-flight. Consolidated; not a test file. |
| `stripe.twin.test.ts` | Stripe seam suite — consumes `twinSession`, resets between tests. |
| `slack.twin.test.ts` | Slack seam suite — consumes `twinSession`, resets between tests. |
| `../twinSession.test.ts` | Unit tests for `twinSession` (mocked fs + CLI). Runs in the DEFAULT `npm test` — no twin needed. |
| `../../../scripts/twinsSetup.ts` | `test:twins:setup` — provision + write config. |
| `../../../scripts/twinsTeardown.ts` | `test:twins:teardown` — teardown + remove config. |

> **Setup/teardown scripts are LIVE-BEHAVIOR-UNVERIFIED** until an Arga quota is
> available: the CLI flags and provision-JSON field names mirror what the suites
> already parse, but the end-to-end provision → reset → teardown cycle has not
> been run (the account was at 0/10 quota as of 2026-07-20). Validate the first
> real run and confirm the "E-commerce Checkout" scenario id from
> `arga previews twins list --json`.
