import * as fs from 'fs';
import * as path from 'path';

/**
 * ENG-1059: compiled tests must not ship in the Elastic Beanstalk artifact.
 *
 * These assertions pin BOTH halves of the fix, because the cheap "simplification"
 * of this change is actively dangerous:
 *
 *   - `npm run build` must exclude tests, so `dist/` (and therefore the EB zip)
 *     carries no compiled test code.
 *   - `tsconfig.json` must NOT exclude tests, because `npm run typecheck` runs
 *     over it and is the ONLY thing type-checking the backend on a PR --
 *     `tsconfig.jest.json` sets `isolatedModules: true`, so ts-jest is
 *     transpile-only and reports no type errors at all (see the ENG-729 comment
 *     in .github/workflows/tests.yml).
 *
 * Moving the exclusion "up" into tsconfig.json would look like a tidy-up and
 * would silently delete type coverage for every test file in the repo, with no
 * red check anywhere. That is what the second test below exists to stop.
 */

const backendRoot = path.resolve(__dirname, '..', '..');

const readJson = (file: string): any => {
  const full = path.join(backendRoot, file);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
};

const readRepoFile = (file: string): string => {
  return fs.readFileSync(path.resolve(backendRoot, '..', file), 'utf8');
};

const TEST_EXCLUDE_GLOBS = ['src/**/__tests__/**', 'src/**/*.test.ts'];

describe('ENG-1059 build/typecheck tsconfig split', () => {
  describe('tsconfig.build.json (the deploy path)', () => {
    it('exists', () => {
      expect(fs.existsSync(path.join(backendRoot, 'tsconfig.build.json'))).toBe(true);
    });

    it('extends the root tsconfig so compiler options cannot drift', () => {
      expect(readJson('tsconfig.build.json').extends).toBe('./tsconfig.json');
    });

    it('excludes test files from the emitted output', () => {
      const exclude: string[] = readJson('tsconfig.build.json').exclude;
      for (const glob of TEST_EXCLUDE_GLOBS) {
        expect(exclude).toContain(glob);
      }
    });

    it('still excludes node_modules (exclude replaces, not merges, on extends)', () => {
      // A child tsconfig's `exclude` REPLACES the parent's rather than merging
      // with it, so dropping node_modules here would silently pull the whole
      // dependency tree into the build program.
      expect(readJson('tsconfig.build.json').exclude).toContain('node_modules');
    });
  });

  describe('tsconfig.json (the type-check gate) — must stay broad', () => {
    it('does NOT exclude test files, so npm run typecheck still covers them', () => {
      const exclude: string[] = readJson('tsconfig.json').exclude ?? [];
      for (const glob of TEST_EXCLUDE_GLOBS) {
        expect(exclude).not.toContain(glob);
      }
      expect(exclude.some((e) => e.includes('__tests__') || e.includes('.test.ts'))).toBe(false);
    });

    it('still includes the whole src tree', () => {
      expect(readJson('tsconfig.json').include).toContain('src/**/*');
    });
  });

  describe('package.json wiring', () => {
    it('build compiles through tsconfig.build.json', () => {
      expect(readJson('package.json').scripts.build).toContain('-p tsconfig.build.json');
    });

    it('typecheck does NOT use tsconfig.build.json (it must see the tests)', () => {
      const typecheck: string = readJson('package.json').scripts.typecheck;
      expect(typecheck).toContain('--noEmit');
      expect(typecheck).not.toContain('tsconfig.build.json');
    });
  });

  describe('cloud test-environment build', () => {
    it('copies the deploy tsconfig before npm run build', () => {
      const dockerfile = readRepoFile('test-env/Dockerfile.backend');
      const configCopy = dockerfile.indexOf('COPY backend/tsconfig.build.json ./');
      const build = dockerfile.indexOf('npm run build');

      expect(configCopy).toBeGreaterThanOrEqual(0);
      expect(build).toBeGreaterThan(configCopy);
    });
  });

  describe('tsconfig.jest.json (the test runner) — untouched by the split', () => {
    it('still includes the whole src tree, so no suite is dropped', () => {
      expect(readJson('tsconfig.jest.json').include).toContain('src/**/*.ts');
    });

    it('does not exclude test files', () => {
      const exclude: string[] = readJson('tsconfig.jest.json').exclude ?? [];
      expect(exclude.some((e) => e.includes('__tests__') || e.includes('.test.ts'))).toBe(false);
    });
  });
});
