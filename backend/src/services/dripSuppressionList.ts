/**
 * ENG-2554 (ENG-2167 Phase 1 compliance): do-not-email suppression matcher.
 * Pure — no I/O, no storage, not yet wired into a send path. Invalid
 * recipients fail closed (treated as suppressed).
 */

export type SuppressionReason = 'exact' | 'domain' | 'invalid_address';

export interface SuppressionList {
  addresses: ReadonlySet<string>;
  domains: ReadonlySet<string>;
  /** Raw entries that could not be parsed and were ignored. */
  rejected: string[];
}

export interface SuppressionResult {
  suppressed: boolean;
  reason?: SuppressionReason;
}

const LOCAL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function normalizeDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase();
  return DOMAIN_RE.test(d) ? d : null;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || s.indexOf('@') !== at) return null;
  const local = s.slice(0, at);
  const domain = normalizeDomain(s.slice(at + 1));
  if (!domain || local.length > 64 || !LOCAL_RE.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  return `${local}@${domain}`;
}

export function buildSuppressionList(entries: readonly unknown[]): SuppressionList {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  const rejected: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string') {
      rejected.push(String(entry));
      continue;
    }
    const t = entry.trim();
    const domainPart = t.startsWith('*@') ? t.slice(2) : t.startsWith('@') ? t.slice(1) : null;
    if (domainPart !== null) {
      const d = normalizeDomain(domainPart);
      if (d) domains.add(d);
      else rejected.push(entry);
      continue;
    }
    const e = normalizeEmail(t);
    if (e) addresses.add(e);
    else rejected.push(entry);
  }
  return { addresses, domains, rejected };
}

export function checkSuppression(list: SuppressionList, email: unknown): SuppressionResult {
  const e = normalizeEmail(email);
  if (!e) return { suppressed: true, reason: 'invalid_address' };
  if (list.addresses.has(e)) return { suppressed: true, reason: 'exact' };
  if (list.domains.has(e.slice(e.lastIndexOf('@') + 1))) return { suppressed: true, reason: 'domain' };
  return { suppressed: false };
}

export interface FilteredRecipients {
  allowed: string[];
  suppressed: Array<{ email: string; reason: SuppressionReason }>;
}

export function filterRecipients(list: SuppressionList, emails: readonly unknown[]): FilteredRecipients {
  const allowed: string[] = [];
  const suppressed: FilteredRecipients['suppressed'] = [];
  const seen = new Set<string>();
  for (const raw of emails ?? []) {
    const norm = normalizeEmail(raw);
    const key = norm ?? `invalid:${String(raw)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = checkSuppression(list, raw);
    if (r.suppressed) suppressed.push({ email: norm ?? String(raw), reason: r.reason! });
    else allowed.push(norm!);
  }
  return { allowed, suppressed };
}
