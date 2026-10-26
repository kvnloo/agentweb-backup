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
import { buildCaptureRoute, buildLandingPageMiddleware, type AttributionCookiesMode } from './v0Service';

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
  /** ENG-2666: the site's configured attribution-cookie mode; default 'on'. */
  attributionCookies?: AttributionCookiesMode;
}

// Static patterns for the exact literal shapes buildCaptureRoute() emits. Only a JSON
// string literal (or `undefined`) / a flat string->string object literal is masked; any
// other initializer (a function call, a computed expression) is left unmasked and so
// reports as drift instead of a false `match`.
const STR = String.raw`"(?:[^"\\\n]|\\.)*"`;
const PER_SITE_PATTERNS: Array<[string, RegExp]> = [
  [
    'const LIST_BY_PATH: Record<string, string> = <per-site>;',
    new RegExp(String.raw`^const LIST_BY_PATH: Record<string, string> = \{(?:\s*${STR}\s*:\s*${STR}\s*,?)*\s*\};$`, 'm'),
  ],
  ['const FORWARD_URL = <per-site>;', new RegExp(String.raw`^const FORWARD_URL = ${STR};$`, 'm')],
  ['const PIXEL_ID = <per-site>;', new RegExp(String.raw`^const PIXEL_ID = (?:${STR}|undefined);$`, 'm')],
  ['const META_ACCOUNT_ID = <per-site>;', new RegExp(String.raw`^const META_ACCOUNT_ID = (?:${STR}|undefined);$`, 'm')],
];

function normalize(source: string): string[] {
  let text = source.replace(/\r\n/g, '\n');
  for (const [placeholder, re] of PER_SITE_PATTERNS) {
    text = text.replace(re, placeholder);
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
    compare('middleware.ts', buildLandingPageMiddleware({ attributionCookies: deployed.attributionCookies }), deployed.middleware),
    compare('app/api/capture/route.ts', buildCaptureRoute({}), deployed.captureRoute),
  ];
  return { drifted: files.some((f) => f.status !== 'match'), files };
}
