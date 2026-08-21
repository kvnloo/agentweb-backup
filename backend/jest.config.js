module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  verbose: false,
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
  // ENG-1376: no `coverageThreshold` here on purpose. Coverage is now collected
  // by BOTH backend jobs and merged before it is judged (see the
  // backend-coverage job in .github/workflows/tests.yml), so a per-job jest
  // threshold would fail each job against a fraction of the evidence. The
  // single enforcement point is backend/coverage-thresholds.json, applied once
  // by scripts/coverage-report.mjs. Previously there were two mechanisms and
  // this one was dead: CI passed `--coverageThreshold='{}'` to disable it and
  // re-implemented the same 95% bar in a github-script step.
};
