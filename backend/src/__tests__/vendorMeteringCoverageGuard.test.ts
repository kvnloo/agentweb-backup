/**
 * Vendor metering coverage guard (ENG-701).
 *
 * Sibling to sdkConstructionGuard.test.ts, one layer broader: that guard stops
 * unmetered *LLM* SDK construction outside utils/llmClients.ts. This one stops
 * unmetered *paid third-party vendor* egress in general (search, enrichment,
 * media generation, captcha-solving, landing-page generation, ...).
 *
 * Why this exists: the ENG-666 codebase audit (2026-07-29, origin/main @
 * 211045f2e) found ~12 paid vendors with zero metering, and nothing stopped a
 * 13th from shipping unmetered — coverage discovered by an audit decays the
 * moment the audit ends. This test makes coverage a CI fact instead: every
 * known paid-vendor egress module must either call the metered vendor
 * recorder (usageRecorderService's recordUsage/recordVendorUsage, added in
 * ENG-693) or be named in VENDOR_ALLOWLIST below with the Linear issue that
 * will cover it. A brand-new module matching one of the VENDOR_SIGNATURES
 * that does neither fails the build.
 *
 * The scanning logic (scanForVendorViolations / findStaleAllowlistEntries) is
 * a pure function over an in-memory file map so its four behavioral
 * guarantees are proven directly against synthetic fixtures, independent of
 * today's real vendor list. The "real repo" describe block below then runs
 * the same function against backend/src and the seeded allowlist.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

/** A distinctive, low-false-positive marker for a paid vendor's egress call. */
interface VendorSignature {
  vendor: string;
  /** Regex matching the vendor's SDK import or a literal endpoint/domain unique to it. */
  re: RegExp;
}

/**
 * Marks a file as recording usage through the metered ledger
 * (usageRecorderService.recordUsage / recordVendorUsage, from ENG-693). Any
 * OTHER "recordUsage" (e.g. Apollo/enrich.so's call-count quota trackers) does
 * not count — those are visibility, not the $ ledger.
 *
 * Requires BOTH an import of recordUsage/recordVendorUsage FROM
 * usageRecorderService AND an actual call to one of them — a bare substring
 * match on "usageRecorderService" (e.g. inside a comment, a string literal, or
 * an unused import) must not be enough to claim a module is metered
 * (CodeRabbit finding on this PR, ENG-701).
 */
const USAGE_RECORDER_IMPORT = /import\s*\{[^}]*\b(?:recordUsage|recordVendorUsage)\b[^}]*\}\s*from\s*['"][^'"]*usageRecorderService['"]/;
const USAGE_RECORDER_CALL = /\b(?:recordUsage|recordVendorUsage)\s*\(/;

function isMetered(content: string): boolean {
  return USAGE_RECORDER_IMPORT.test(content) && USAGE_RECORDER_CALL.test(content);
}

interface AllowlistEntry {
  /** Path relative to src/, forward-slash separated. */
  path: string;
  vendor: string;
  /** Linear issue tracking the slice that will meter this module. */
  issue: string;
  reason: string;
}

/**
 * Known paid-vendor egress signatures. Permanent once added — like the
 * FORBIDDEN_PATTERNS in sdkConstructionGuard.test.ts, entries are never
 * removed just because today's call site got metered (a *new* unmetered call
 * site for the same vendor must still be caught).
 */
const VENDOR_SIGNATURES: VendorSignature[] = [
  { vendor: 'v0 (Vercel)', re: /['"]v0-sdk['"]/ },
  { vendor: 'You.com search', re: /ydc-index\.io/ },
  { vendor: 'Google Custom Search', re: /google\.customsearch\(/ },
  { vendor: 'Apollo', re: /api\.apollo\.io/ },
  { vendor: 'enrich.so', re: /dev\.enrich\.so/ },
  { vendor: 'ElevenLabs', re: /api\.elevenlabs\.io/ },
  { vendor: '2captcha', re: /2captcha\.com/ },
  { vendor: 'Placid', re: /api\.placid\.app/ },
  { vendor: 'Remotion Lambda', re: /@remotion\/lambda/ },
];

/**
 * Every currently-unmetered paid-vendor egress module, seeded from the
 * ENG-666 codebase audit (2026-07-29, origin/main @ 211045f2e; re-verified
 * 2026-08-19 — ENG-664/X-Twitter and ENG-693/vendor-dimension have since
 * shipped and are intentionally NOT here, ENG-700/unpriced-unit fail-loud is
 * about pricing, not egress, so it isn't a module in this sense either).
 *
 * Each entry is a bet the named issue will pay off: when that issue wires the
 * module through usageRecorderService, the staleness test below fails the
 * build until the entry is deleted. Do not add an entry without a real Linear
 * issue tracking the fix. Do not delete an entry to make the build green —
 * meter the module instead.
 */
const VENDOR_ALLOWLIST: AllowlistEntry[] = [
  {
    path: 'services/v0Service.ts',
    vendor: 'v0 (Vercel)',
    issue: 'ENG-694',
    reason: '9 billable v0.chats.create/sendMessage sites; none record usage yet.',
  },
  {
    path: 'search/youSearchProvider.ts',
    vendor: 'You.com search',
    issue: 'ENG-695',
    reason: 'ydc-index.io queries are unmetered; the owning user is discarded at the seam.',
  },
  {
    path: 'search/googleSearchProvider.ts',
    vendor: 'Google Custom Search',
    issue: 'ENG-695',
    reason: 'Same search seam as You.com — billed customsearch.cse.list calls are unmetered.',
  },
  {
    path: 'services/apolloServiceFactory.ts',
    vendor: 'Apollo',
    issue: 'ENG-696',
    reason: 'apolloService.ts only tracks a call-count quota; no $ ledger entry is written.',
  },
  {
    path: 'services/enrichSoServiceFactory.ts',
    vendor: 'enrich.so',
    issue: 'ENG-696',
    reason: 'Structural twin of Apollo — call-count quota only, no $ ledger entry.',
  },
  {
    path: 'services/voiceoverService.ts',
    vendor: 'ElevenLabs',
    issue: 'ENG-698',
    reason: 'Text-to-speech calls are unmetered.',
  },
  {
    path: 'emma/solveRecaptchaTool.ts',
    vendor: '2captcha',
    issue: 'ENG-698',
    reason: 'submit2CaptchaTask solve calls are unmetered.',
  },
  {
    path: 'controllers/tasks.ts',
    vendor: 'Placid',
    issue: 'ENG-698',
    reason: 'Editor-token and rendered-image fetch calls are unmetered.',
  },
  {
    path: 'services/remotionService.ts',
    vendor: 'Remotion Lambda',
    issue: 'ENG-699',
    reason: 'renderMediaOnLambda submissions are unmetered.',
  },
];

// ─── Pure scanning logic (unit-tested against fixtures below) ────────────────

/**
 * Scan an in-memory file map for unmetered paid-vendor egress. A file
 * "violates" when it matches a vendor signature, does NOT call the metered
 * recorder, and has no (valid) allowlist entry for that exact vendor.
 */
function scanForVendorViolations(
  files: ReadonlyMap<string, string>,
  signatures: readonly VendorSignature[],
  allowlist: readonly AllowlistEntry[]
): string[] {
  const allowlistByPath = new Map(allowlist.map((e) => [e.path, e]));
  const violations: string[] = [];

  for (const [rel, content] of files) {
    for (const { vendor, re } of signatures) {
      if (!re.test(content)) continue;
      if (isMetered(content)) continue; // metered — no allowlist needed

      const entry = allowlistByPath.get(rel);
      if (!entry) {
        violations.push(
          `${rel} calls ${vendor} and records no usage (no allowlist entry). ` +
            'Wire it through usageRecorderService (recordUsage/recordVendorUsage), ' +
            'or add it to VENDOR_ALLOWLIST with the Linear issue that will cover it.'
        );
      } else if (entry.vendor !== vendor) {
        violations.push(
          `${rel} matches vendor "${vendor}" but its allowlist entry names "${entry.vendor}" — ` +
            'fix the entry so the allowlist stays honest about which vendor is unmetered.'
        );
      } else if (!/^ENG-\d+$/.test(entry.issue) || entry.reason.trim().length === 0) {
        violations.push(
          `${rel} is allowlisted for ${vendor} but has no valid Linear issue reference + reason.`
        );
      }
    }
  }

  return violations;
}

/**
 * An allowlist entry is stale when its module no longer needs amnesty: the
 * file was deleted, it no longer matches the vendor it was allowlisted for,
 * or — the case this guard exists to catch — it now calls the metered
 * recorder and the entry was simply never removed.
 */
function findStaleAllowlistEntries(
  files: ReadonlyMap<string, string>,
  signatures: readonly VendorSignature[],
  allowlist: readonly AllowlistEntry[]
): string[] {
  const stale: string[] = [];

  for (const entry of allowlist) {
    const content = files.get(entry.path);
    if (content === undefined) {
      stale.push(`${entry.path} (file no longer exists — remove from VENDOR_ALLOWLIST)`);
      continue;
    }

    const signature = signatures.find((s) => s.vendor === entry.vendor);
    if (!signature || !signature.re.test(content)) {
      stale.push(`${entry.path} (no longer matches vendor "${entry.vendor}" — remove from VENDOR_ALLOWLIST)`);
      continue;
    }

    if (isMetered(content)) {
      stale.push(
        `${entry.path} (now records usage via usageRecorderService — ${entry.issue} shipped, remove from VENDOR_ALLOWLIST)`
      );
    }
  }

  return stale;
}

// ─── Mechanism tests — synthetic fixtures, independent of the real repo ──────

describe('vendor metering guard mechanism (fixtures)', () => {
  const SIGS: VendorSignature[] = [{ vendor: 'FakeVendor', re: /fake-vendor\.example\.com/ }];

  it('fails a new module that calls a paid vendor and records no usage', () => {
    const files = new Map([['services/newVendorThing.ts', "fetch('https://fake-vendor.example.com/bill-me')"]]);
    const violations = scanForVendorViolations(files, SIGS, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/services\/newVendorThing\.ts/);
    expect(violations[0]).toMatch(/records no usage/);
  });

  it('fails an allowlist entry with a missing/malformed issue reference', () => {
    const files = new Map([['services/newVendorThing.ts', "fetch('https://fake-vendor.example.com/bill-me')"]]);
    const allowlist: AllowlistEntry[] = [
      { path: 'services/newVendorThing.ts', vendor: 'FakeVendor', issue: 'not-a-real-issue', reason: 'tbd' },
    ];
    const violations = scanForVendorViolations(files, SIGS, allowlist);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/no valid Linear issue reference/);
  });

  it('fails an allowlist entry with an empty reason', () => {
    const files = new Map([['services/newVendorThing.ts', "fetch('https://fake-vendor.example.com/bill-me')"]]);
    const allowlist: AllowlistEntry[] = [
      { path: 'services/newVendorThing.ts', vendor: 'FakeVendor', issue: 'ENG-9999', reason: '   ' },
    ];
    const violations = scanForVendorViolations(files, SIGS, allowlist);
    expect(violations).toHaveLength(1);
  });

  it('passes a vendor module that is knowingly unmetered while its allowlist entry names the tracking issue', () => {
    const files = new Map([['services/newVendorThing.ts', "fetch('https://fake-vendor.example.com/bill-me')"]]);
    const allowlist: AllowlistEntry[] = [
      { path: 'services/newVendorThing.ts', vendor: 'FakeVendor', issue: 'ENG-9999', reason: 'tracked' },
    ];
    expect(scanForVendorViolations(files, SIGS, allowlist)).toEqual([]);
  });

  it('passes a vendor module that already records usage through usageRecorderService, with no allowlist entry', () => {
    const files = new Map([
      [
        'services/newVendorThing.ts',
        "import { recordVendorUsage } from './usageRecorderService';\nfetch('https://fake-vendor.example.com/bill-me');\nvoid recordVendorUsage({});",
      ],
    ]);
    expect(scanForVendorViolations(files, SIGS, [])).toEqual([]);
  });

  it('fails when an allowlisted module has since started metering (staleness — the amnesty must expire)', () => {
    const files = new Map([
      [
        'services/newVendorThing.ts',
        "import { recordVendorUsage } from './usageRecorderService';\nfetch('https://fake-vendor.example.com/bill-me');\nvoid recordVendorUsage({});",
      ],
    ]);
    const allowlist: AllowlistEntry[] = [
      { path: 'services/newVendorThing.ts', vendor: 'FakeVendor', issue: 'ENG-9999', reason: 'tracked' },
    ];
    const stale = findStaleAllowlistEntries(files, SIGS, allowlist);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/now records usage/);
  });

  it('passes an allowlisted module that is still genuinely unmetered', () => {
    const files = new Map([['services/newVendorThing.ts', "fetch('https://fake-vendor.example.com/bill-me')"]]);
    const allowlist: AllowlistEntry[] = [
      { path: 'services/newVendorThing.ts', vendor: 'FakeVendor', issue: 'ENG-9999', reason: 'tracked' },
    ];
    expect(findStaleAllowlistEntries(files, SIGS, allowlist)).toEqual([]);
  });

  it('flags a stale entry whose file was deleted', () => {
    const allowlist: AllowlistEntry[] = [
      { path: 'services/deleted.ts', vendor: 'FakeVendor', issue: 'ENG-9999', reason: 'tracked' },
    ];
    const stale = findStaleAllowlistEntries(new Map(), SIGS, allowlist);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/no longer exists/);
  });

  // CodeRabbit (this PR): a bare substring match on "usageRecorderService" must
  // not be enough to claim a module is metered — a comment or an unused import
  // proves nothing about whether usage is actually recorded.
  it('does NOT treat a module as metered from a comment merely mentioning usageRecorderService', () => {
    const files = new Map([
      [
        'services/newVendorThing.ts',
        "fetch('https://fake-vendor.example.com/bill-me'); // TODO: wire through usageRecorderService one day",
      ],
    ]);
    const violations = scanForVendorViolations(files, SIGS, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/records no usage/);
  });

  it('does NOT treat a module as metered from an unused usageRecorderService import with no call', () => {
    const files = new Map([
      [
        'services/newVendorThing.ts',
        "import { recordVendorUsage } from './usageRecorderService';\nfetch('https://fake-vendor.example.com/bill-me');",
      ],
    ]);
    const violations = scanForVendorViolations(files, SIGS, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/records no usage/);
  });

  it('DOES treat a module as metered when both the import and an actual call are present', () => {
    const files = new Map([
      [
        'services/newVendorThing.ts',
        "import { recordUsage } from '../services/usageRecorderService';\nfetch('https://fake-vendor.example.com/bill-me');\nvoid recordUsage({ model: 'x' } as any);",
      ],
    ]);
    expect(scanForVendorViolations(files, SIGS, [])).toEqual([]);
  });
});

// ─── Real-repo tests — the actual guard, run against backend/src ─────────────

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // __tests__ construct mocks freely; node_modules never appears under src.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      listSourceFiles(full, acc);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function loadRealRepoFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const full of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, full).split(path.sep).join('/');
    files.set(rel, fs.readFileSync(full, 'utf8'));
  }
  return files;
}

describe('Vendor metering coverage guard (ENG-701, real repo)', () => {
  it('no unmetered paid-vendor egress outside the allowlist', () => {
    const violations = scanForVendorViolations(loadRealRepoFiles(), VENDOR_SIGNATURES, VENDOR_ALLOWLIST);
    if (violations.length > 0) {
      throw new Error(
        'Unmetered paid-vendor egress found outside VENDOR_ALLOWLIST.\n\nViolations:\n' +
          violations.map((v) => `  - ${v}`).join('\n')
      );
    }
  });

  it('no allowlist entry is stale (its module still needs the amnesty it claims)', () => {
    const stale = findStaleAllowlistEntries(loadRealRepoFiles(), VENDOR_SIGNATURES, VENDOR_ALLOWLIST);
    expect(stale).toEqual([]);
  });

  it('names every currently-unmetered paid vendor, so the coverage gap is readable from this file alone', () => {
    // Intentionally explicit. This list has exactly one legitimate way to
    // shrink: a slice issue ships metering into the module, which the
    // staleness test above then requires removing the entry for.
    expect(VENDOR_ALLOWLIST.map((e) => `${e.vendor} (${e.path}) — ${e.issue}`).sort()).toEqual([
      '2captcha (emma/solveRecaptchaTool.ts) — ENG-698',
      'Apollo (services/apolloServiceFactory.ts) — ENG-696',
      'ElevenLabs (services/voiceoverService.ts) — ENG-698',
      'Google Custom Search (search/googleSearchProvider.ts) — ENG-695',
      'Placid (controllers/tasks.ts) — ENG-698',
      'Remotion Lambda (services/remotionService.ts) — ENG-699',
      'You.com search (search/youSearchProvider.ts) — ENG-695',
      'enrich.so (services/enrichSoServiceFactory.ts) — ENG-696',
      'v0 (Vercel) (services/v0Service.ts) — ENG-694',
    ]);
  });
});
