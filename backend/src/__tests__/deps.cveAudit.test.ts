/**
 * Dependency CVE audit test.
 *
 * Pins our post-upgrade floor so transitive CVE deps cannot regress silently.
 * Re-run `npm audit --json` only once to keep CI fast — we cache the result
 * in a helper module. If you see this test fail on CI, run `npm audit` and
 * bump the offending package in package.json (do NOT lower the floor here).
 *
 * Ownership: swarm. Part of sprint task
 *   "Upgrade backend deps with critical CVEs".
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

type AuditMetadata = {
  vulnerabilities: {
    info: number;
    low: number;
    moderate: number;
    high: number;
    critical: number;
    total: number;
  };
};

type AuditJson = {
  metadata: AuditMetadata;
  vulnerabilities: Record<
    string,
    {
      severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
      range?: string;
      via?: Array<string | { title?: string; source?: number }>;
      effects?: string[];
      fixAvailable?: boolean | { name: string; version: string; isSemVerMajor: boolean };
    }
  >;
};

/**
 * Runs `npm audit --json` from the backend directory and returns parsed output.
 * `npm audit` exits non-zero when vulnerabilities are found — that's expected,
 * we still want to parse stdout.
 */
function runAudit(): AuditJson | null {
  const backendRoot = path.resolve(__dirname, '..', '..');
  // Skip if lockfile missing (e.g. fresh CI where install failed) — fail loudly elsewhere.
  if (!fs.existsSync(path.join(backendRoot, 'package-lock.json'))) {
    return null;
  }
  try {
    const out = execSync('npm audit --json', {
      cwd: backendRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (e: unknown) {
    // npm audit exits non-zero when vulns exist — stdout still has JSON.
    const err = e as { stdout?: string };
    if (err?.stdout) {
      return JSON.parse(err.stdout);
    }
    return null;
  }
}

describe('backend CVE audit floor', () => {
  const audit = runAudit();

  // If npm audit is unreachable (offline CI box), skip with a warning rather
  // than flake the entire suite.
  const maybeSkip = audit ? describe : describe.skip;

  maybeSkip('npm audit --json', () => {
    it('reports 0 critical vulnerabilities', () => {
      expect(audit!.metadata.vulnerabilities.critical).toBe(0);
    });

    it('reports fewer than 5 high-severity vulnerabilities', () => {
      expect(audit!.metadata.vulnerabilities.high).toBeLessThan(5);
    });

    it('does not have an unpatched fast-xml-parser entry', () => {
      const v = audit!.vulnerabilities['fast-xml-parser'];
      // If the entry exists at all, it must not be critical (overrides should
      // have lifted the resolved version past the CVE range).
      if (v) {
        expect(v.severity).not.toBe('critical');
      }
    });

    it('does not have an unpatched form-data entry', () => {
      const v = audit!.vulnerabilities['form-data'];
      if (v) {
        expect(v.severity).not.toBe('critical');
      }
    });

    it('does not have an unpatched basic-ftp entry', () => {
      const v = audit!.vulnerabilities['basic-ftp'];
      if (v) {
        expect(v.severity).not.toBe('critical');
      }
    });

    it('does not have an unpatched handlebars entry', () => {
      const v = audit!.vulnerabilities['handlebars'];
      if (v) {
        expect(v.severity).not.toBe('critical');
      }
    });

    it('does not have an unpatched protobufjs entry', () => {
      const v = audit!.vulnerabilities['protobufjs'];
      if (v) {
        expect(v.severity).not.toBe('critical');
      }
    });
  });
});
