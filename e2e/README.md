# AgentWeb E2E runner

This is an additive `tester-army/e2e` lane. It does **not** replace
`backend/src/__tests__/e2e`, Atem diagnostics, or manual Playwright verification.

## Why this first slice is deterministic

The PR lane exercises the public Partner Portal sign-in surface with locators and
assertions only. It needs no model provider, test account, AWS credential, or
write-capable token, so fork/PR code never receives application secrets.

The runner starts Vite through `app.command` and owns teardown, matching the
upstream E2E CI guidance. Set `E2E_PARTNER_URL` to reuse the same test against an
already-running AgentWeb test environment (for example on Atem) instead.

## Run locally

From the repository root, install Partner Portal dependencies before starting the runner; otherwise a fresh clone cannot launch Vite.

```bash
npm ci --prefix partner-portal
cd e2e
npm install
npm exec -- e2e-web install chromium
npm test
```

CI additionally installs Chromium system dependencies, emits JUnit + JSON
reports, keeps failure artifacts, disables E2E telemetry, and treats this lane
as advisory while it runs in parallel with AgentWeb's existing build checks.

Upstream: https://github.com/tester-army/e2e
