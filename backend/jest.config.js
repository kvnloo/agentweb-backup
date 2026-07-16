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
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/e2e/'],
  transformIgnorePatterns: ['/node_modules/(?!@projectwallace/)'],
  moduleNameMapper: {
    // marked v16 is ESM-only; redirect to manual mock so Jest (CJS mode) can load it
    '^marked$': '<rootDir>/__mocks__/marked.ts',
    // Safety net for twitter-api-v2: if a test file's own jest.mock('twitter-api-v2', factory)
    // ever fails to register, resolution falls back here instead of the real SDK, so a test can
    // never silently make a live HTTP call to X's production API. See __mocks__/twitter-api-v2.ts.
    '^twitter-api-v2$': '<rootDir>/__mocks__/twitter-api-v2.ts',
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
