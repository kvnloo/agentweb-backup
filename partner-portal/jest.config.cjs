module.exports = {
  preset: 'ts-jest',
  // Cap workers on DEVELOPER MACHINES ONLY. jest resolves maxWorkers as
  // CLI > config > (cores - 1), so a config literal overrides the core count in
  // BOTH directions — and that makes a bare `maxWorkers: 2` mean opposite things
  // on different machines:
  //
  //   8-core dev box: default 7  -> 2   a cap, which is the point
  //   2-core CI runner: default 1 -> 2   a DOUBLING, which is not
  //
  // Capping unconditionally turned CI red: AdminDashboard.usageCreditDefault is a
  // user-event test on a 5s timeout, and oversubscribing a 2-vCPU ubuntu-latest
  // runner is enough to blow it. It passed on main and failed only here.
  //
  // Locally the cap earns its place — at 7 workers three suites fail
  // (HtmlTemplates, GTMPlans, AdminDashboard.usageCreditDefault); at 2, one does.
  // So: cap where it caps, and leave CI on the default it was already passing with.
  ...(process.env.CI ? {} : { maxWorkers: 2 }),
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