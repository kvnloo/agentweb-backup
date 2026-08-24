/**
 * ENG-1111. Generalizes the ENG-960 and ENG-1112 findings: nothing in the test harness
 * stopped a real network request from leaving the box. `routes/seo.ts` (ENG-960) and
 * `resendService.ts` (ENG-1112) each reached a live third-party host over `fetch` because
 * nothing here distinguished a test run from production -- both suites stayed green
 * because the third party rejected the request, not because the code path was mocked.
 *
 * This is the shared policy enforced at both call sites that can issue a real request in
 * this codebase: the global `fetch` wrapper (setup.ts, covers Node's native fetch and any
 * SDK -- e.g. `resend` -- built on top of it) and the `node-fetch` module mock
 * (__mocks__/node-fetch.ts, a separate implementation not covered by wrapping
 * globalThis.fetch). One list here means an allowlist entry can't drift between them.
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// Hosts a test is explicitly permitted to reach for real, each earning its entry with a
// comment saying why. Empty on purpose: every real-network call found in the ENG-1111
// sweep (ENG-960's Search Console call, ENG-1112's Resend call, the docs-corpus fetches)
// got a proper stub instead of an allowlist entry -- see the PR body for the full list.
// Add an entry here only when a real call to a non-local host is genuinely intended
// during a test run (e.g. a dedicated sandbox API with no meaningful side effects).
export const ALLOWED_HOSTNAMES = new Set<string>();

// ENG-1210 AC11: the usage-runway E2E suite is the case the paragraph above
// anticipated -- a run that is SUPPOSED to reach a real host, because reaching it is
// the whole measurement. It is opened dynamically rather than by a static entry so the
// guard stays fully armed for every ordinary run: `RUN_E2E_TESTS` is unset in CI and in
// local `npm test` (jest also ignores `__tests__/e2e/` outright), so this set is empty
// exactly when it needs to be. Only the single host named by `E2E_BASE_URL` is opened,
// never a wildcard -- and the suite itself independently refuses to run against a
// production-looking target, so this cannot become a back door to prod.
if (process.env.RUN_E2E_TESTS === 'true' && process.env.E2E_BASE_URL) {
  try {
    ALLOWED_HOSTNAMES.add(new URL(process.env.E2E_BASE_URL).hostname);
  } catch {
    // An unparseable E2E_BASE_URL opens nothing; the suite fails on its own login step
    // with a clearer message than anything this guard could produce.
  }
}

export class RealNetworkEgressError extends Error {
  constructor(url: string, testName: string) {
    super(
      `[ENG-1111] Blocked a real network request to ${url}` +
        (testName ? ` from test "${testName}"` : '') +
        `. Backend tests must never reach a non-local host -- mock the call ` +
        `(a service-level jest.mock, or a moduleNameMapper safety net like ` +
        `__mocks__/resend.ts) instead of relying on the third party to reject it.`
    );
    this.name = 'RealNetworkEgressError';
  }
}

function currentTestName(): string {
  try {
    return typeof expect !== 'undefined' && typeof expect.getState === 'function'
      ? expect.getState().currentTestName ?? ''
      : '';
  } catch {
    return '';
  }
}

/**
 * Throws `RealNetworkEgressError` for any absolute URL whose host is not local or
 * explicitly allowlisted. A non-absolute/unparseable URL (a relative path against an
 * in-process supertest agent, for example) never leaves the process, so it passes through
 * untouched -- there is nothing to guard.
 */
export function assertLocalOrAllowed(rawUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return;
  }
  if (LOCAL_HOSTNAMES.has(hostname) || ALLOWED_HOSTNAMES.has(hostname)) return;
  throw new RealNetworkEgressError(rawUrl, currentTestName());
}
