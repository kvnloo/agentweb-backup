# AgentWeb TesterArmy E2E lane

This is an additive browser acceptance lane built with
[`tester-army/e2e`](https://github.com/tester-army/e2e). It does **not**
replace AgentWeb's existing backend E2E suites or Atem test plane.

The first slice deliberately uses deterministic locators only: it exercises the
public Partner Portal sign-in → registration entry flow without a model,
application secret, test account, AWS credential, or write-capable token.

## Run

```bash
cd e2e
npm install
npm exec -- e2e-web install chromium
npm test
```

By default the runner starts Partner Portal on a free loopback port and owns
teardown. To point the exact same suite at an already-running Atem/test
environment, set `E2E_PARTNER_URL`.

CI is an **advisory parallel signal** while this lane incubates. It follows the
upstream CI guidance: compatible Node, Chromium + system dependencies, JUnit
and JSON reports, failure artifacts, one-failure cutoff, no telemetry, no
model credentials.

## Provenance

Upstream framework: TesterArmy's `e2e`. Package metadata credits Oskar
Kwaśniewski and Szymon Rybczak as contributors. AgentWeb keeps their framework
separate from its incumbent suites so both signals can be compared before any
replacement decision.
