/**
 * ENG-2547 (ENG-2167 slice): pure SalesForge handoff eligibility.
 *
 * Decides whether a lead in the air-cover drip sequence should be pushed into
 * SalesForge. Pure: no SalesForge API calls, no persistence, no worker wiring.
 *
 * Precedence: suppressed > already_pushed > not_opted_in > invalid_email >
 * not_warm > outside_window.
 */

export type SalesforgeHandoffReason =
  | 'not_opted_in'
  | 'invalid_email'
  | 'not_warm'
  | 'outside_window'
  | 'suppressed'
  | 'already_pushed';

export interface SalesforgeHandoffLead {
  email?: string | null;
  optedIn?: boolean | null;
  tags?: readonly string[] | null;
  /** Epoch ms when the lead was enrolled into the air-cover sequence. */
  enrolledAtMs?: number | null;
  unsubscribed?: boolean | null;
  bounced?: boolean | null;
  complained?: boolean | null;
  salesforgePushedAt?: string | number | null;
}

export interface SalesforgeHandoffConfig {
  warmTags: readonly string[];
  suppressionTags?: readonly string[];
  /** Air-cover window in days. Defaults to 3. */
  windowDays?: number;
}

export interface DecideSalesforgeHandoffInput {
  lead: SalesforgeHandoffLead;
  nowMs: number;
  config: SalesforgeHandoffConfig;
}

export type SalesforgeHandoffDecision =
  | { eligible: true }
  | { eligible: false; reason: SalesforgeHandoffReason };

export const DEFAULT_AIR_COVER_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeTags(tags: readonly string[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const t of tags ?? []) {
    if (typeof t !== 'string') continue;
    const n = t.trim().toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

function hasAny(leadTags: Set<string>, wanted: readonly string[] | undefined): boolean {
  for (const w of normalizeTags(wanted)) {
    if (leadTags.has(w)) return true;
  }
  return false;
}

export function decideSalesforgeHandoff(
  input: DecideSalesforgeHandoffInput,
): SalesforgeHandoffDecision {
  const { lead, nowMs, config } = input;
  const leadTags = normalizeTags(lead.tags);

  if (
    lead.unsubscribed === true ||
    lead.bounced === true ||
    lead.complained === true ||
    hasAny(leadTags, config.suppressionTags)
  ) {
    return { eligible: false, reason: 'suppressed' };
  }

  const pushed = lead.salesforgePushedAt;
  if (pushed !== null && pushed !== undefined && pushed !== '') {
    return { eligible: false, reason: 'already_pushed' };
  }

  if (lead.optedIn !== true) return { eligible: false, reason: 'not_opted_in' };

  const email = typeof lead.email === 'string' ? lead.email.trim() : '';
  if (!EMAIL_RE.test(email)) return { eligible: false, reason: 'invalid_email' };

  if (!hasAny(leadTags, config.warmTags)) return { eligible: false, reason: 'not_warm' };

  const windowDays =
    typeof config.windowDays === 'number' && Number.isFinite(config.windowDays) && config.windowDays >= 0
      ? config.windowDays
      : DEFAULT_AIR_COVER_WINDOW_DAYS;
  const enrolled = lead.enrolledAtMs;
  if (
    typeof enrolled !== 'number' ||
    !Number.isFinite(enrolled) ||
    enrolled > nowMs ||
    nowMs - enrolled > windowDays * DAY_MS
  ) {
    return { eligible: false, reason: 'outside_window' };
  }

  return { eligible: true };
}
