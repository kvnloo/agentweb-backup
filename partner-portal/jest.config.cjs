module.exports = {
  preset: 'ts-jest',
  // Cap workers. jest defaults to cores-1, so on an 8-core box this suite runs 7
  // ts-jest workers plus the master. Measured on this repo, capping to 2 does not
  // merely save CPU — it makes the suite MORE reliable: at 7 workers three suites
  // fail (HtmlTemplates, GTMPlans, AdminDashboard.usageCreditDefault — 5 tests), at
  // 2 workers only the last one does. Those are user-event tests on 5s timeouts, and
  // contention is what tips them over; the same test takes 32s to time out at 7
  // workers versus 14s at 2, and passes in 2.7s run alone.
  //
  // Matches backend/jest.config.js, which caps for the same reason.
  maxWorkers: 2,
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: {
        jsx: 'react-jsx',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.(test|spec).(ts|tsx|js)',
    '<rootDir>/src/**/*.(test|spec).(ts|tsx|js)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/*.config.*',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};