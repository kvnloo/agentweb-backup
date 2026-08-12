module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  verbose: false,
  maxWorkers: 2, // Limit to 2 workers to reduce memory usage in CI
  workerIdleMemoryLimit: '512MB', // Force garbage collection when workers are idle
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
  },
  collectCoverageFrom: [
    'src/utils/**/*.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**',
  ],
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
};
