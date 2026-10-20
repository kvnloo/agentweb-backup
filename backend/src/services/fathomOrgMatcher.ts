/**
 * Cautious org/contact matcher for Fathom recordings (ENG-2531, slice of ENG-246).
 *
 * Pure and read-only: all lookups go through an injected port; this module never
 * creates or mutates accounts/contacts. Precedence is strict:
 *   1. exact participant email match (known contact)
 *   2. org website/domain match
 *   3. known CRM contact match
 *   4. review
 * Title/name-only evidence never yields a match. Internal @agentweb.pro participants
 * are ignored. Conflicting candidates at the deciding tier return review with the
 * candidate list.
 */

export const INTERNAL_DOMAINS = ['agentweb.pro'] as const;

/** Consumer mailbox domains: a shared domain is not evidence of an org. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

export interface RecordingParticipant {
  email?: string | null;
  name?: string | null;
}

export interface MatchInput {
  participants: RecordingParticipant[];
  title?: string | null;
  /** Domain extracted from the recording (e.g. from transcript/invite), if any. */
  extractedDomain?: string | null;
}

export interface OrgCandidate {
  orgId: string;
  contactId?: string;
}

export interface OrgLookupPort {
  findContactsByEmail(email: string): Promise<OrgCandidate[]>;
  findOrgsByDomain(domain: string): Promise<OrgCandidate[]>;
  findCrmContactsByEmail(email: string): Promise<OrgCandidate[]>;
}

export type MatchBasis = 'email' | 'domain' | 'crm';

export type MatchResult =
  | { match: { orgId: string; contactId?: string; basis: MatchBasis }; confidence: 'high' | 'medium' | 'low' }
  | { review: 'conflicting_candidates'; basis: MatchBasis; candidates: OrgCandidate[] }
  | { review: 'no_external_participants' | 'insufficient_evidence' };

const CONFIDENCE: Record<MatchBasis, 'high' | 'medium' | 'low'> = {
  email: 'high',
  domain: 'medium',
  crm: 'low',
};

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function normalizeDomain(domain: string | null | undefined): string | null {
  let d = (domain ?? '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

function isInternal(domain: string): boolean {
  return INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function dedupeByOrg(cands: OrgCandidate[]): OrgCandidate[] {
  const contacts = new Map<string, Set<string>>();
  for (const c of cands) {
    const set = contacts.get(c.orgId) ?? new Set<string>();
    if (c.contactId) set.add(c.contactId);
    contacts.set(c.orgId, set);
  }
  // Same org with several contacts: the org is unambiguous, the contact is not.
  return [...contacts.entries()]
    .map(([orgId, set]) => (set.size === 1 ? { orgId, contactId: [...set][0] } : { orgId }))
    .sort((a, b) => a.orgId.localeCompare(b.orgId));
}

function decide(basis: MatchBasis, cands: OrgCandidate[]): MatchResult | null {
  const orgs = dedupeByOrg(cands);
  if (orgs.length === 0) return null;
  if (orgs.length > 1) return { review: 'conflicting_candidates', basis, candidates: orgs };
  const [only] = orgs;
  return {
    match: { orgId: only.orgId, ...(only.contactId ? { contactId: only.contactId } : {}), basis },
    confidence: CONFIDENCE[basis],
  };
}

async function collect(keys: string[], fn: (k: string) => Promise<OrgCandidate[]>): Promise<OrgCandidate[]> {
  const out: OrgCandidate[] = [];
  for (const k of keys) out.push(...(await fn(k)));
  return out;
}

export async function matchFathomRecording(input: MatchInput, port: OrgLookupPort): Promise<MatchResult> {
  const emails = [...new Set(
    input.participants
      .map((p) => normalizeEmail(p.email))
      .filter((e): e is string => !!e && !isInternal(e.split('@')[1])),
  )].sort();

  const domains = new Set<string>();
  const extracted = normalizeDomain(input.extractedDomain);
  if (extracted && !isInternal(extracted) && !FREE_MAIL_DOMAINS.has(extracted)) domains.add(extracted);
  for (const e of emails) {
    const d = e.split('@')[1];
    if (!FREE_MAIL_DOMAINS.has(d)) domains.add(d);
  }

  if (emails.length === 0 && domains.size === 0) {
    // Only internal participants, names, and/or a title: never a match.
    return { review: 'no_external_participants' };
  }

  const byEmail = decide('email', await collect(emails, (e) => port.findContactsByEmail(e)));
  if (byEmail) return byEmail;

  const byDomain = decide('domain', await collect([...domains].sort(), (d) => port.findOrgsByDomain(d)));
  if (byDomain) return byDomain;

  const byCrm = decide('crm', await collect(emails, (e) => port.findCrmContactsByEmail(e)));
  if (byCrm) return byCrm;

  return { review: 'insufficient_evidence' };
}
