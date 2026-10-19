/**
 * ENG-2545 (child of ENG-2167): pure monthly newsletter cadence/eligibility decision.
 *
 * Decides whether a newsletter-segment member should receive this month's issue.
 * No persistence, network, or Resend calls — the caller owns sending and recording
 * `lastIssueMonth`. Fails closed on invalid config and suppression signals.
 */

export interface NewsletterMember {
  joinedSegmentAt: Date;
  lastIssueMonth?: string | null; // YYYY-MM (UTC)
  unsubscribed?: boolean;
  bounced?: boolean;
  complained?: boolean;
}

export interface NewsletterCadenceConfig {
  sendDay?: number; // 1-28, default 1
  minDaysInSegment?: number; // default 7
}

export type NewsletterSkipReason =
  | 'invalid_config'
  | 'suppressed'
  | 'before_send_day'
  | 'already_sent_this_month'
  | 'joined_after_issue'
  | 'invalid_now';

export type NewsletterCadenceDecision =
  | { action: 'send'; issueMonth: string }
  | { action: 'skip'; reason: NewsletterSkipReason };

const DAY_MS = 24 * 60 * 60 * 1000;

export function issueMonthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function newsletterCadence(
  member: NewsletterMember,
  now: Date,
  config: NewsletterCadenceConfig = {},
): NewsletterCadenceDecision {
  const sendDay = config.sendDay ?? 1;
  const minDays = config.minDaysInSegment ?? 7;
  if (!Number.isInteger(sendDay) || sendDay < 1 || sendDay > 28) return { action: 'skip', reason: 'invalid_config' };
  if (!Number.isFinite(minDays) || minDays < 0) return { action: 'skip', reason: 'invalid_config' };

  // Compliance first.
  if (member.unsubscribed || member.bounced || member.complained) return { action: 'skip', reason: 'suppressed' };

  if (!Number.isFinite(now.getTime())) return { action: 'skip', reason: 'invalid_now' };
  if (now.getUTCDate() < sendDay) return { action: 'skip', reason: 'before_send_day' };

  const issueMonth = issueMonthOf(now);
  if (member.lastIssueMonth === issueMonth) return { action: 'skip', reason: 'already_sent_this_month' };

  const joined = member.joinedSegmentAt.getTime();
  if (!Number.isFinite(joined) || now.getTime() - joined < minDays * DAY_MS) {
    return { action: 'skip', reason: 'joined_after_issue' };
  }

  return { action: 'send', issueMonth };
}
