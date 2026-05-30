module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  clearMocks: true,
  verbose: false,
  maxWorkers: 4, // Use all 4 vCPUs on the CI runner; workerIdleMemoryLimit below caps memory growth
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
