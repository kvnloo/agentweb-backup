import { postSlackMessage } from './slackService';

export type LeadCaptureFailureReason = 'list_not_found' | 'public_access_disabled';

export interface LeadCaptureFailureInput {
  reason: LeadCaptureFailureReason;
  listId: string;
  status: number;
  source?: string;
  email?: string;
  userId?: string;
}

const REASON_LABEL: Record<LeadCaptureFailureReason, string> = {
  list_not_found: 'target lead list does not exist',
  public_access_disabled: 'target lead list is not public (publicAccessEnabled !== true)',
};

/**
 * Records a lead-capture failure at the forward-lead webhook boundary.
 *
 * A 404 (list_not_found) or 403 (public_access_disabled) means a LIVE landing
 * page is POSTing leads to a list that cannot accept them — from the visitor's
 * side the form "succeeds" while every submission is dropped. This is the exact
 * failure that silently lost the demystifying-ai lander's leads (the client
 * swallowed the 404 and showed a success screen).
 *
 * Always emits a structured error log with the `lead_capture_failure` marker so
 * log aggregation can alert on it. Additionally posts to Slack when
 * LEAD_CAPTURE_ALERT_SLACK_CHANNEL is configured. Default-off: with no channel
 * set it is log-only and carries no infra dependency. Never throws — recording a
 * failure must not break the request path it is observing.
 */
export async function recordLeadCaptureFailure(input: LeadCaptureFailureInput): Promise<void> {
  const { reason, listId, status, source, email, userId } = input;

  // 1. Structured log — always. The `lead_capture_failure` marker is the stable
  //    hook for log-based alerting; the Slack post below is a convenience layer.
  console.error('[lead-capture-failure]', JSON.stringify({
    marker: 'lead_capture_failure',
    reason,
    status,
    listId,
    source: source || null,
    userId: userId || null,
    // Log only the email domain, not the full lead address (PII minimization).
    emailDomain: typeof email === 'string' && email.includes('@') ? email.split('@').pop() : null,
    at: new Date().toISOString(),
  }));

  // 2. Slack — only when an ops channel is explicitly configured.
  const channel = process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL;
  if (!channel) return;

  const text = [
    ':rotating_light: *Lead capture failing* — a live landing page is dropping leads.',
    `*Reason:* ${REASON_LABEL[reason]} (HTTP ${status})`,
    `*List ID:* \`${listId}\``,
    source ? `*Source / lander:* \`${source}\`` : '',
    userId ? `*List owner:* \`${userId}\`` : '',
    reason === 'list_not_found'
      ? 'Fix: repoint the lander to a real list, or recreate the list.'
      : 'Fix: enable public access on the list in CRM settings.',
  ].filter(Boolean).join('\n');

  try {
    await postSlackMessage(channel, text);
  } catch (err) {
    // Slack is best-effort; the structured log above is the durable record.
    console.error('[lead-capture-failure] slack post failed:', err);
  }
}
