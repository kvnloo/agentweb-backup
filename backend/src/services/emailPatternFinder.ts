/**
 * Pattern-based email finder.
 *
 * Last-resort tier in the email-discovery waterfall. Generates ~10 common
 * email patterns from (firstName, lastName, domain) and validates each via
 * enrich.so's email-validation API. Returns the first one that comes back
 * as `deliverable`. Bails immediately if the domain is catchall (validation
 * can't distinguish real from fake addresses on catchall domains).
 *
 * Cost: up to N enrich.so validation credits per lead (default cap 10).
 * Stops at first deliverable, so the realistic average is 3–5 calls per
 * resolved lead.
 */

import { getEnrichSoService, type ValidateResult } from './enrichSoService';

export interface PatternFinderResult {
  found: boolean;
  email?: string;
  /** Which pattern produced the hit. Useful for telemetry. */
  pattern?: string;
  status?: 'deliverable' | 'risky';
  /** True when validation said the domain is catchall — pattern guessing is
   *  meaningless on those, so we abort the tier. */
  catchall?: boolean;
  /** How many validation calls were made. Used for credit accounting. */
  attempts: number;
}

/**
 * Fold accented characters to ASCII for email-pattern generation.
 *   "Müller" → "muller",  "José" → "jose",  "Žilina" → "zilina"
 * Without NFKD-folding, the bare `[^a-z0-9]` strip would drop diacritics
 * entirely ("Müller" → "mller"), which produces wrong patterns.
 */
function foldToAscii(s: string): string {
  return s
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Generate candidate email patterns. Order matters — we stop at first
 * deliverable, so common patterns first to minimize credit burn.
 */
export function generateEmailPatterns(
  firstName: string,
  lastName: string,
  domain: string,
): string[] {
  const f = foldToAscii(firstName ?? '');
  const l = foldToAscii(lastName ?? '');
  const d = (domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!d || !d.includes('.')) return [];
  if (!f && !l) return [];

  // Order by perceived prevalence in B2B SaaS. Stops early at first hit.
  const patterns: string[] = [];
  if (f && l) {
    patterns.push(`${f}.${l}@${d}`);          // john.doe@
    patterns.push(`${f[0]}${l}@${d}`);        // jdoe@
    patterns.push(`${f}${l}@${d}`);           // johndoe@
    patterns.push(`${f}@${d}`);               // john@
    patterns.push(`${f}_${l}@${d}`);          // john_doe@
    patterns.push(`${f}-${l}@${d}`);          // john-doe@
    patterns.push(`${f}.${l[0]}@${d}`);       // john.d@
    patterns.push(`${f[0]}.${l}@${d}`);       // j.doe@
    patterns.push(`${l}@${d}`);               // doe@
    patterns.push(`${l}${f[0]}@${d}`);        // doej@
  } else if (f) {
    patterns.push(`${f}@${d}`);
  } else if (l) {
    patterns.push(`${l}@${d}`);
  }
  return patterns;
}

export interface PatternFinderOptions {
  userId?: string;
  /** Cap on how many patterns to validate. Default 10. */
  maxAttempts?: number;
  /** Inject a different validator (used by tests). Defaults to enrich.so. */
  validate?: (email: string, opts: { userId?: string }) => Promise<ValidateResult>;
}

/**
 * Try each pattern via enrich.so validation. Stop at first deliverable.
 * Track risky hits as a fallback when no deliverable found.
 */
export async function findEmailViaPatterns(
  firstName: string,
  lastName: string,
  domain: string,
  opts: PatternFinderOptions = {},
): Promise<PatternFinderResult> {
  const patterns = generateEmailPatterns(firstName, lastName, domain);
  if (patterns.length === 0) return { found: false, attempts: 0 };

  const cap = Math.max(1, Math.min(opts.maxAttempts ?? 10, patterns.length));
  const validate = opts.validate ?? (async (email: string, o: { userId?: string }) => {
    const svc = getEnrichSoService();
    return svc.validateEmail(email, o);
  });

  let attempts = 0;
  let bestRisky: { email: string; pattern: string } | null = null;

  for (let i = 0; i < cap; i++) {
    const candidate = patterns[i];
    attempts++;
    let result: ValidateResult;
    try {
      result = await validate(candidate, { userId: opts.userId });
    } catch {
      continue;   // transient validation failure — try next pattern
    }

    // Catchall short-circuit: every pattern on a catchall domain returns
    // "deliverable" even for nonsense addresses. The result is meaningless,
    // so we bail and let the caller fall through to other tiers (or surface
    // "no email found" rather than guess wrong).
    if (result.isCatchAll) {
      return { found: false, catchall: true, attempts };
    }

    if (result.status === 'deliverable') {
      return { found: true, email: candidate, pattern: candidate, status: 'deliverable', attempts };
    }
    if (result.status === 'risky' && !bestRisky) {
      bestRisky = { email: candidate, pattern: candidate };
    }
    // 'undeliverable' / 'unknown' → keep trying.
  }

  if (bestRisky) {
    return {
      found: true,
      email: bestRisky.email,
      pattern: bestRisky.pattern,
      status: 'risky',
      attempts,
    };
  }
  return { found: false, attempts };
}
