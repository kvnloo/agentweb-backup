/**
 * ENG-1289: detect a live site whose platform-owned capture files have drifted from
 * the canonical output of `buildLandingPageMiddleware()` / `buildCaptureRoute()`.
 *
 * The capture files are INJECTED at generation / domain-attach time
 * (`injectLeadCaptureAttribution`), not derived per request. A site generated before a
 * capture fix (ENG-308 dual middleware writers, ENG-309 skipped injection) keeps the
 * stale or missing files forever, and the symptom is the "0 of N leads carry a click ID"
 * meta-attribution-blackout alert. This turns that diagnosis from a manual code audit
 * into a pure comparison.
 *
 * Pure: the caller fetches the deployed files (or passes `null` when a file is absent).
 * The middleware is site-independent, so it is compared exactly. The capture route has
 * four per-site constants (lead-list map, forward URL, pixel id, Meta account id); those
 * declarations are masked on both sides, and everything else must match exactly.
 */
import { buildCaptureRoute, buildLandingPageMiddleware } from './v0Service';

export type CaptureFileStatus = 'match' | 'missing' | 'drifted';

export interface CaptureFileDrift {
  path: string;
  status: CaptureFileStatus;
  /** 1-based line of the first difference after normalization, when drifted. */
  firstDiffLine?: number;
  expectedLine?: string;
  actualLine?: string;
}

export interface CaptureDriftReport {
  drifted: boolean;
  files: CaptureFileDrift[];
}

export interface DeployedCaptureFiles {
  middleware: string | null;
  captureRoute: string | null;
}

const PER_SITE_CONSTANTS = ['LIST_BY_PATH', 'FORWARD_URL', 'PIXEL_ID', 'META_ACCOUNT_ID'];

function normalize(source: string): string[] {
  let text = source.replace(/\r\n/g, '\n');
  for (const name of PER_SITE_CONSTANTS) {
    // `const NAME[: Type] = <value>;` where value may span lines (the JSON map).
    const re = new RegExp(`const ${name}(\\s*:[^=]+)?\\s*=[\\s\\S]*?;\\n`);
    text = text.replace(re, `const ${name} = <per-site>;\n`);
  }
  return text.trimEnd().split('\n').map((l) => l.trimEnd());
}

function compare(path: string, expected: string, actual: string | null): CaptureFileDrift {
  if (actual === null || actual === undefined) return { path, status: 'missing' };
  const want = normalize(expected);
  const got = normalize(actual);
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (want[i] !== got[i]) {
      return {
        path,
        status: 'drifted',
        firstDiffLine: i + 1,
        expectedLine: want[i] ?? '<end of file>',
        actualLine: got[i] ?? '<end of file>',
      };
    }
  }
  return { path, status: 'match' };
}

export function detectCaptureDrift(deployed: DeployedCaptureFiles): CaptureDriftReport {
  const files = [
    compare('middleware.ts', buildLandingPageMiddleware(), deployed.middleware),
    compare('app/api/capture/route.ts', buildCaptureRoute({}), deployed.captureRoute),
  ];
  return { drifted: files.some((f) => f.status !== 'match'), files };
}
