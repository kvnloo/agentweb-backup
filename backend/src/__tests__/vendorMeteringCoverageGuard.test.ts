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
import * as ts from 'typescript';

import { METERED_VENDOR_PROVIDERS } from '../services/usageAnalyticsService';

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

function isMeteredDirectly(content: string): boolean {
  return USAGE_RECORDER_IMPORT.test(content) && USAGE_RECORDER_CALL.test(content);
}

/** `import { a, b } from './x'` / `import x from '../y'` — relative imports only. */
const LOCAL_IMPORT = /import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+['"](\.[^'"]*)['"]/g;

/**
 * Resolve a relative specifier against the importing file, to a key in the
 * in-memory file map. `.ts` is appended because that is what the map holds; an
 * index file is tried too, since `./foo` may mean `foo/index.ts`.
 */
function resolveLocalImport(fromRel: string, spec: string): string[] {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const parts = (dir ? `${dir}/${spec}` : spec).split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const base = stack.join("/");
  return [`${base}.ts`, `${base}/index.ts`];
}

/**
 * True when `rel` records usage — directly, or through ONE hop of a local
 * helper that does.
 *
 * ENG-1797: the direct-only check was a false negative that mattered.
 * `v0Service.ts` meters every one of its eleven call sites through
 * `meteredV0`, never importing the recorder itself, so the guard could not see
 * it — and the module stayed allowlisted as unmetered. Removing that metering
 * would have shipped green, which is the one thing ENG-701 exists to prevent.
 *
 * ONE hop, deliberately. It covers the helper pattern actually in use and
 * keeps this a pure, terminating function over the file map; arbitrary depth
 * would need cycle handling and would start calling a module "metered" on the
 * strength of a relationship no reader could see.
 *
 * The imported name must also be CALLED here. An unused helper import proves
 * nothing, which is the same strictness the direct check already applies after
 * ENG-701's review finding.
 */
function isMetered(rel: string, content: string, files: ReadonlyMap<string, string>): boolean {
  if (isMeteredDirectly(content)) return true;

  for (const match of content.matchAll(LOCAL_IMPORT)) {
    const named = (match[1] || match[2] || "")
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/).pop()!.trim())
      .filter(Boolean);
    if (!named.length) continue;

    for (const candidate of resolveLocalImport(rel, match[3])) {
      const helper = files.get(candidate);
      if (helper === undefined || !isMeteredDirectly(helper)) continue;
      if (named.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(content))) return true;
    }
  }

  return false;
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
  { vendor: 'Enigma', re: /api\.enigma\.com/ },
  { vendor: 'ElevenLabs', re: /api\.elevenlabs\.io/ },
  { vendor: '2captcha', re: /2captcha\.com/ },
  { vendor: 'Placid', re: /api\.placid\.app/ },
  { vendor: 'Remotion Lambda', re: /@remotion\/lambda/ },
  { vendor: 'Twilio', re: /api\.twilio\.com|(?:from\s+|require\(\s*|import\(\s*)['"]twilio(?:\/[^'"]*)?['"]/ },
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
    path: 'services/voice/voiceProvider.ts',
    vendor: 'Twilio',
    issue: 'ENG-2271',
    reason: 'Telephony seam; call minutes are metered by recordCallUsage from the status webhook.',
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
      if (isMetered(rel, content, files)) continue; // metered — no allowlist needed

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

    if (isMetered(entry.path, content, files)) {
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

/**
 * Provider keys passed to `recordVendorUsage` as a shared constant rather than
 * a string literal. Resolved by name so the registry check below still sees
 * them.
 *
 * Kept as an explicit alias map, not a looser regex: a NEW constant-valued
 * provider then fails the registry check loudly and gets an entry here, which
 * is the behaviour we want. A regex broad enough to guess would instead
 * silently "resolve" the wrong thing.
 */
const PROVIDER_CONSTANT_ALIASES: Record<string, string> = {
  TWITTER_PROVIDER: 'twitter', // services/twitterService.ts (ENG-664)
};

/** Lines of a `recordVendorUsage({ ... })` call to scan for its provider key. */
const CALL_WINDOW_LINES = 15;

/**
 * Every provider key the repo actually meters, read from the `provider:` field
 * of each `recordVendorUsage` call.
 *
 * Scoped to a window after each call site rather than the whole file, because
 * the search providers carry an unrelated `provider: this.name` on their own
 * result objects — a file-wide scan would report `this` as a vendor.
 */
function meteredProviderKeysInRepo(files: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  for (const content of files.values()) {
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (!/recordVendorUsage\s*\(/.test(line)) return;
      const window = lines.slice(i, i + CALL_WINDOW_LINES).join('\n');
      for (const m of window.matchAll(/provider:\s*(?:(['"])([^'"]+)\1|([A-Z][A-Z0-9_]*))/g)) {
        const key = m[2] ?? PROVIDER_CONSTANT_ALIASES[m[3]!];
        if (key) found.add(key);
      }
    });
  }
  return [...found].sort();
}

describe('helper-indirected metering (ENG-1797)', () => {
  const SIGS: VendorSignature[] = [{ vendor: 'FakeVendor', re: /fake-vendor\.example\.com/ }];

  const METERED_HELPER = `
    import { recordVendorUsage } from "./usageRecorderService";
    export function meteredFake(ctx: any, call: any) { recordVendorUsage(ctx); return call; }
  `;
  const CALLER = `
    import { meteredFake } from "./fakeMetering";
    meteredFake({}, () => fetch('https://fake-vendor.example.com/bill-me'));
  `;

  it('sees a module metered through ONE hop of a local helper', () => {
    // The false negative this fixes: v0Service.ts meters all eleven of its call
    // sites through meteredV0 and never imports the recorder itself, so the
    // direct-only check reported it as unmetered.
    const files = new Map([
      ['services/fakeMetering.ts', METERED_HELPER],
      ['services/fakeVendorThing.ts', CALLER],
    ]);

    expect(scanForVendorViolations(files, SIGS, [])).toEqual([]);
  });

  it('does NOT count an unused helper import', () => {
    // Same strictness the direct check already applies: an import proves
    // nothing unless the thing is actually called.
    const files = new Map([
      ['services/fakeMetering.ts', METERED_HELPER],
      [
        'services/fakeVendorThing.ts',
        `import { meteredFake } from "./fakeMetering";
         fetch('https://fake-vendor.example.com/bill-me');`,
      ],
    ]);

    expect(scanForVendorViolations(files, SIGS, [])).toHaveLength(1);
  });

  it('does NOT count a helper that is not itself metered', () => {
    const files = new Map([
      ['services/fakeMetering.ts', 'export function meteredFake(c: any, call: any) { return call; }'],
      ['services/fakeVendorThing.ts', CALLER],
    ]);

    expect(scanForVendorViolations(files, SIGS, [])).toHaveLength(1);
  });

  it('does not follow a SECOND hop, so "metered" never rests on an invisible chain', () => {
    const files = new Map([
      ['services/fakeMetering.ts', METERED_HELPER],
      ['services/middle.ts', 'import { meteredFake } from "./fakeMetering";\nexport const passThrough = meteredFake;'],
      ['services/fakeVendorThing.ts', `import { passThrough } from "./middle";\npassThrough({}, () => fetch('https://fake-vendor.example.com/bill-me'));`],
    ]);

    expect(scanForVendorViolations(files, SIGS, [])).toHaveLength(1);
  });

  it('flags an allowlist entry as stale once the module becomes helper-metered', () => {
    // This is the state v0Service.ts was in: genuinely metered, still
    // allowlisted as unmetered, with nothing to say so.
    const files = new Map([
      ['services/fakeMetering.ts', METERED_HELPER],
      ['services/fakeVendorThing.ts', CALLER],
    ]);
    const allowlist: AllowlistEntry[] = [
      { path: 'services/fakeVendorThing.ts', vendor: 'FakeVendor', issue: 'ENG-9999', reason: 'unmetered' },
    ];

    const stale = findStaleAllowlistEntries(files, SIGS, allowlist);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/now records usage/);
  });

  it('catches the regression the amnesty used to hide: metering removed from the helper', () => {
    // The inverse test. With the helper no longer metering, the caller must be
    // reported — previously the allowlist entry made this ship green.
    const files = new Map([
      ['services/fakeMetering.ts', 'export function meteredFake(c: any, call: any) { return call; }'],
      ['services/fakeVendorThing.ts', CALLER],
    ]);

    const violations = scanForVendorViolations(files, SIGS, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/records no usage/);
  });

  it('resolves a parent-relative helper import', () => {
    const files = new Map([
      ['services/fakeMetering.ts', METERED_HELPER],
      [
        'search/fakeVendorThing.ts',
        `import { meteredFake } from "../services/fakeMetering";
         meteredFake({}, () => fetch('https://fake-vendor.example.com/bill-me'));`,
      ],
    ]);

    expect(scanForVendorViolations(files, SIGS, [])).toEqual([]);
  });
});

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
      'Twilio (services/voice/voiceProvider.ts) — ENG-2271',
    ]);
    // Empty from ENG-698 (2026-09-14) until ENG-2271: the Twilio telephony seam meters per call
    // minute from the status webhook rather than at the API call, so it is the one amnesty entry.
    // The staleness and scan tests above still run, so a NEW unmetered vendor fails the build
    // exactly as before; an empty amnesty list remains the goal state.
  });

  /**
   * ENG-1837. The admin provider picker offers METERED_VENDOR_PROVIDERS, so
   * that list has to mean "has a live adapter" and not "was true when someone
   * last edited it".
   *
   * Both directions are failures, and they fail differently:
   *  - a key in the registry with no adapter → a dropdown option that can only
   *    ever render empty, which reads as "this vendor costs nothing";
   *  - an adapter missing from the registry → a metered vendor that is absent
   *    from the picker until it happens to have spend in the selected window.
   */
  it('METERED_VENDOR_PROVIDERS matches the providers actually metered in the repo (ENG-1837)', () => {
    expect(meteredProviderKeysInRepo(loadRealRepoFiles())).toEqual(
      [...METERED_VENDOR_PROVIDERS].sort()
    );
  });
});

// ─── ENG-1929: no cost computed inline in a metering call ────────────────────

/**
 * Every `recordVendorUsage({ ... costUsd: <call> })` where `costUsd` contains a
 * function call.
 *
 * That argument is evaluated BEFORE the fire-and-forget call, so a pricing
 * function that throws (the rate card threw on a missing rate by design, and
 * X's pricer still does) propagates into the vendor request and fails the
 * user's search or render. Pricing belongs inside the recorder, via `rateKey`,
 * or in a value computed beforehand within its own guard. A plain value —
 * literal, identifier, property access, arithmetic on those — cannot throw
 * and is allowed.
 *
 * AST rather than regex, for the same reasons sdkConstructionGuard gives:
 * comments, strings and formatting cannot fool it.
 */
function findInlineCostComputations(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [rel, content] of files) {
    if (!content.includes('recordVendorUsage')) continue;
    const sourceFile = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true);
    const containsCall = (node: ts.Node): boolean =>
      ts.isCallExpression(node) || ts.isNewExpression(node) || ts.forEachChild(node, containsCall) === true;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'recordVendorUsage' &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const prop of node.arguments[0].properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'costUsd' &&
            containsCall(prop.initializer)
          ) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(prop.getStart());
            found.push(`${rel}:${line + 1}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found.sort();
}

describe('no cost computed inline in a metering call (ENG-1929)', () => {
  const fixture = (content: string) => new Map([['services/newVendor.ts', content]]);

  it('flags a pricing call evaluated as the costUsd argument', () => {
    expect(
      findInlineCostComputations(
        fixture("void recordVendorUsage({ provider: 'x', costSource: 'allocated', costUsd: priceIt('x', 1) });"),
      ),
    ).toEqual(['services/newVendor.ts:1']);
  });

  it('flags a call nested inside an expression', () => {
    expect(
      findInlineCostComputations(fixture("recordVendorUsage({ costUsd: 2 * lookupRate('x') });")),
    ).toHaveLength(1);
  });

  it('allows rateKey, and a costUsd that is already a value', () => {
    expect(
      findInlineCostComputations(
        fixture(
          [
            "void recordVendorUsage({ provider: 'x', rateKey: 'query', quantity: 1 });",
            "void recordVendorUsage({ costSource: 'allocated', costUsd: cost.costUsd });",
            "void recordVendorUsage({ costSource: 'allocated', costUsd: rate * quantity });",
            "void recordVendorUsage({ costSource: 'allocated', costUsd: 0 });",
            '// recordVendorUsage({ costUsd: computeAllocatedCost() }) in a comment',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });

  it('backend/src has no inline cost computation in any recordVendorUsage call', () => {
    expect(findInlineCostComputations(loadRealRepoFiles())).toEqual([]);
  });
});
