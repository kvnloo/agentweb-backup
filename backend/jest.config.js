module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  verbose: false,
  // Jest's 5000ms default is too tight for this machine's full-512-suite pre-push run:
  // observed 4 distinct, unrelated test files (metaLaunchGate.test.ts,
  // metaLaunchGateWiring.test.ts, and others) trip the identical "exceeded timeout" symptom on a
  // test whose own logic is mock-only with no real I/O — each one passes cleanly in isolation.
  // Not a per-test defect to patch one file at a time; raising the default gives every test the
  // same headroom rather than chasing each new file that happens to land on a slow scheduling
  // slot. A genuinely hung test still times out, just later.
  testTimeout: 15000,
  maxWorkers: 2, // Limit to 2 workers to reduce memory usage in CI
  // ENG-1277: NOT a GC trigger despite the old comment. jest-worker checks each
  // worker's heapUsed after every test file and restarts the child process (full
  // node + jest bootstrap) once it exceeds this limit (jest-worker's
  // ChildProcessWorker checkMemoryUsage). Measured on origin/main@96a8a1206 with
  // --logHeapUsage: agentMode-suite files leave 357-660MB resident (median ~400),
  // so most of them triggered a restart under the old 512MB limit. Workers already
  // inherit --max-old-space-size=4096 from the `test`/`test:coverage` npm scripts,
  // so 1.5GB per worker (x2 workers) is well inside the CI runner's memory — a
  // genuinely leaking worker still recycles before that ceiling. Measured A/B:
  // raising this to 1GB cut a 60-file agentMode sample from 59.5s to 39.4s
  // (-34%, identical tests/assertions/coverage); 1.5GB gives headroom above the
  // measured 660MB peak without materially more restart-avoidance than 1GB.
  workerIdleMemoryLimit: '1.5GB',
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json'
      }
    ]
  },
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/e2e/', '/__tests__/twins/'],
  transformIgnorePatterns: ['/node_modules/(?!@projectwallace/)'],
  moduleNameMapper: {
    // marked v16 is ESM-only; redirect to manual mock so Jest (CJS mode) can load it
    '^marked$': '<rootDir>/__mocks__/marked.ts',
    // Safety net for twitter-api-v2: if a test file's own jest.mock('twitter-api-v2', factory)
    // ever fails to register, resolution falls back here instead of the real SDK, so a test can
    // never silently make a live HTTP call to X's production API. See __mocks__/twitter-api-v2.ts.
    '^twitter-api-v2$': '<rootDir>/__mocks__/twitter-api-v2.ts',
    // @slack/web-api's real WebClient constructs an axios client at `new WebClient(...)` time,
    // which throws under this project's jest/ts-jest/dependency combination (test-harness-only
    // artifact — the same compiled code runs fine outside Jest). Every file that transitively
    // imports slackService.ts (most of them, via agentModeService.ts) was crashing at
    // module-load time regardless of whether it exercises Slack at all. Tests that actually
    // test Slack behavior keep their own jest.mock('@slack/web-api', ...), which takes
    // precedence over this. See __mocks__/slack-web-api.ts.
    '^@slack/web-api$': '<rootDir>/__mocks__/slack-web-api.ts',
    // Safety net for resend (ENG-1112): the SDK sends over the global `fetch` to
    // api.resend.com, and resendService pulls a live API key from Secrets Manager, so on
    // any host where that secret resolves an un-mocked send left the box for real. The
    // two suites that exercise the SDK boundary keep their own jest.mock('resend', ...),
    // which takes precedence over this. See __mocks__/resend.ts.
    '^resend$': '<rootDir>/__mocks__/resend.ts',
    // ENG-1111: node-fetch is a separate implementation from Node's native `fetch`, so the
    // globalThis.fetch wrapper in setup.ts does not cover it. Delegates to the real
    // node-fetch after the same local-or-allowlisted check. See __mocks__/node-fetch.ts.
    '^node-fetch$': '<rootDir>/__mocks__/node-fetch.ts',
  },
  // ENG-1376: this used to read `src/utils/**/*.ts` only — 112 of the 811
  // source files under src/. The 98.35% the CI comment advertised was 98.35%
  // *of src/utils*, and nothing said so, so it read as a backend-wide number.
  // Measured over the widened scope, with both test jobs' coverage merged, the
  // same suites score 74.02% statements / 64.75% branches / 74.89% functions /
  // 74.79% lines over 729 files (PR #2547 CI). Nothing regressed; the
  // denominator was wrong.
  //
  // Exclusions, and why each one is not a dodge:
  //   *.d.ts          - ambient declarations, no executable statements.
  //   **/__tests__/** - the tests themselves. Must be `**/`, not `src/__tests__/`:
  //                     there are 12 more __tests__ dirs nested under services/,
  //                     routes/, mcp/, etc., and an anchored pattern leaks them
  //                     into the denominator as ~100%-covered "source".
  //   **/__mocks__/** - hand-written module stubs (see moduleNameMapper above).
  //   src/types/**    - type-only declarations.
  //   src/scripts/**  - 69 one-off operational scripts run by hand against real
  //                     AWS/DB, not importable units. Listed in the coverage
  //                     comment as an explicit exclusion so the number stays
  //                     honest about what it skipped.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
    '!src/types/**',
    '!src/scripts/**',
  ],
  // No `coverageThreshold` here on purpose, and nothing enforces one elsewhere
  // either. ENG-1376 made the merged-shard result the single enforcement point;
  // ENG-1463 then removed coverage from CI altogether ("does not run routine
  // product suites, enforce coverage, or deploy staging" — CLAUDE.md), taking
  // that mechanism with it. `collectCoverageFrom` above is kept because it is
  // what makes a local `npm run test:coverage` measure the whole backend rather
  // than one directory; it is a local diagnostic now, not a gate.
};
