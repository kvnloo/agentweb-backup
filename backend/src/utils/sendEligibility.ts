/**
 * Pure send-eligibility decision for CRM email sends (ENG-2518, slice of ENG-2167).
 *
 * Suppression facts are passed in; this module does no I/O. Where those facts
 * are stored and wiring into the live send path are out of scope (ENG-2369).
 */

export type SuppressionReason = 'unsubscribed' | 'do_not_email' | 'hard_bounce' | 'complaint' | 'invalid_address';

export type SendEligibility = { send: true } | { send: false; reason: SuppressionReason };

export interface SuppressionFacts {
  unsubscribed?: Iterable<string>;
  doNotEmail?: Iterable<string>;
  hardBounced?: Iterable<string>;
  complained?: Iterable<string>;
  /** Accepted for completeness; soft bounces alone never suppress. */
  softBounced?: Iterable<string>;
}

export interface SendRecipient {
  email: string;
}

export type Recipient = string | SendRecipient;

// Unquoted dot-atom local part (RFC 5322 atext) and LDH domain labels (RFC 5321/1123).
const LOCAL_ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const EMAIL_RE = new RegExp(`^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);

// RFC 5321 limits: local part <= 64, domain <= 255, whole address <= 254 octets.
function isValidAddress(email: string): boolean {
  if (email.length > 254 || !EMAIL_RE.test(email)) return false;
  const at = email.lastIndexOf('@');
  return at <= 64 && email.length - at - 1 <= 255;
}

export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function toSet(values: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!values) return out;
  for (const v of values) {
    const n = normalizeEmail(v);
    if (n) out.add(n);
  }
  return out;
}

interface CompiledFacts {
  doNotEmail: Set<string>;
  unsubscribed: Set<string>;
  complained: Set<string>;
  hardBounced: Set<string>;
}

function compile(facts: SuppressionFacts): CompiledFacts {
  return {
    doNotEmail: toSet(facts.doNotEmail),
    unsubscribed: toSet(facts.unsubscribed),
    complained: toSet(facts.complained),
    hardBounced: toSet(facts.hardBounced),
  };
}

function recipientEmail(r: Recipient): string {
  return normalizeEmail(typeof r === 'string' ? r : r?.email);
}

function decideCompiled(email: string, c: CompiledFacts): SendEligibility {
  if (!isValidAddress(email)) return { send: false, reason: 'invalid_address' };
  // Explicit human/compliance signals first, then deliverability signals.
  if (c.doNotEmail.has(email)) return { send: false, reason: 'do_not_email' };
  if (c.unsubscribed.has(email)) return { send: false, reason: 'unsubscribed' };
  if (c.complained.has(email)) return { send: false, reason: 'complaint' };
  if (c.hardBounced.has(email)) return { send: false, reason: 'hard_bounce' };
  return { send: true };
}

export function decideSendEligibility(recipient: Recipient, suppressionFacts: SuppressionFacts): SendEligibility {
  return decideCompiled(recipientEmail(recipient), compile(suppressionFacts));
}

export interface PartitionResult<R extends Recipient> {
  sendable: R[];
  suppressed: Array<{ recipient: R; reason: SuppressionReason }>;
}

/** Partition a group send; both lists preserve input order. */
export function partitionRecipients<R extends Recipient>(
  recipients: readonly R[],
  suppressionFacts: SuppressionFacts,
): PartitionResult<R> {
  const compiled = compile(suppressionFacts);
  const result: PartitionResult<R> = { sendable: [], suppressed: [] };
  for (const r of recipients) {
    const d = decideCompiled(recipientEmail(r), compiled);
    if (d.send) result.sendable.push(r);
    else result.suppressed.push({ recipient: r, reason: d.reason });
  }
  return result;
}
