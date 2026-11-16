/**
 * ENG-2550 (ENG-2167 slice): pure customer sending-domain readiness check.
 *
 * Decides whether a customer's own Resend domain (e.g. usehaven.ai) is ready
 * to send drip / one-off email from a given from-address. Pure: no DNS
 * lookups, no Resend calls, no persistence. `domain` mirrors the shape
 * returned by `resendService.getDomain`.
 */

export interface SendingDomainRecord {
  record: string;
  type?: string;
  status: string;
}

export interface SendingDomain {
  name: string;
  status: string;
  records?: readonly SendingDomainRecord[] | null;
}

export type SendingDomainBlocker =
  | 'invalid_from_address'
  | 'missing_domain'
  | 'domain_mismatch'
  | 'domain_not_verified'
  | 'spf_not_verified'
  | 'dkim_not_verified';

export type SendingDomainWarning = 'dmarc_missing';

export interface DecideSendingDomainReadinessInput {
  fromAddress: string | null | undefined;
  domain: SendingDomain | null | undefined;
  /** Raw `_dmarc` TXT value, if the caller looked it up. */
  dmarcTxt?: string | null;
}

export type SendingDomainReadiness =
  | { ready: true; warnings?: SendingDomainWarning[] }
  | { ready: false; reasons: SendingDomainBlocker[]; warnings?: SendingDomainWarning[] };

const EMAIL_RE = /^[^\s@<>]+@([^\s@<>]+\.[^\s@<>]+)$/;

function extractAddress(from: string): string {
  // Accept "Name <addr@host>" as well as a bare address.
  const m = from.match(/<([^>]+)>\s*$/);
  return (m ? m[1] : from).trim();
}

function fromDomain(from: string | null | undefined): string | null {
  if (!from || typeof from !== 'string') return null;
  const m = extractAddress(from).match(EMAIL_RE);
  return m ? m[1].toLowerCase() : null;
}

function recordsVerified(records: readonly SendingDomainRecord[], kind: string): boolean {
  const matching = records.filter((r) => (r.record || '').toUpperCase() === kind);
  return matching.length > 0 && matching.every((r) => (r.status || '').toLowerCase() === 'verified');
}

export function decideSendingDomainReadiness(
  input: DecideSendingDomainReadinessInput,
): SendingDomainReadiness {
  const reasons: SendingDomainBlocker[] = [];
  const warnings: SendingDomainWarning[] = [];

  const fromHost = fromDomain(input.fromAddress);
  if (!fromHost) reasons.push('invalid_from_address');

  const domain = input.domain;
  if (!domain || !domain.name) {
    reasons.push('missing_domain');
  } else {
    const name = domain.name.toLowerCase().replace(/\.$/, '');
    if (fromHost && fromHost !== name && !fromHost.endsWith(`.${name}`)) {
      reasons.push('domain_mismatch');
    }
    if ((domain.status || '').toLowerCase() !== 'verified') reasons.push('domain_not_verified');
    const records = domain.records ?? [];
    if (!recordsVerified(records, 'SPF')) reasons.push('spf_not_verified');
    if (!recordsVerified(records, 'DKIM')) reasons.push('dkim_not_verified');
  }

  if (input.dmarcTxt !== undefined && input.dmarcTxt !== null) {
    if (!/^\s*v=DMARC1\b/i.test(input.dmarcTxt)) warnings.push('dmarc_missing');
  }

  const w = warnings.length ? { warnings } : {};
  return reasons.length ? { ready: false, reasons, ...w } : { ready: true, ...w };
}
