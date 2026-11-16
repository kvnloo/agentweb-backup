/**
 * ENG-527 — the ONE product-feedback filing policy shared by every entry point.
 *
 * Product feedback (bug / feature request) is a support/control-plane operation, not a metered
 * generation: it never consults the token allowance. Both the in-app Send feedback form
 * (`POST /api/support/report-ui-bug`) and Emma's over-quota filing path
 * (`agentModeController.generateResponse` with an explicit `feedbackIntent`) call this function,
 * so the title normalization, replay guard, durable fingerprint and tracker filing cannot drift
 * between them.
 *
 * Failure contract: this throws when nothing was filed (callers must never claim a tracked item)
 * and rethrows `ReportReplayCapacityError` untouched so callers can answer a retryable 503.
 */
import {
  buildReportTitle,
  reportFingerprint,
  fileReportOnce,
  REPORT_CAPACITY_WAIT_MS,
} from '../utils/reportIntake';
import { getUserFunnelStatusIssueTags, getUserFunnelStatusLabel } from '../utils/userFunnelStatus';
import type { FiledUserResult } from './intakeService';

export interface ProductFeedbackReporter {
  userId: string;
  email: string;
  displayName?: string | null;
  funnelStatus?: any;
}

export interface FileProductFeedbackParams {
  user: ProductFeedbackReporter;
  /** Report type key (`bug`, `feature_request`, `improvement`, `feedback`). */
  reportType: string;
  /** Sprint-item title prefix for this report type. */
  titlePrefix: string;
  /** Tracker tag for this report type (in addition to "Customer Reported"). */
  tag: string;
  description: string;
  pageUrl?: string;
  sessionId?: string;
  /** Screenshot URL, "Upload failed", or "Not provided". */
  screenshotContext?: string;
  /** Admin email when an admin files on the user's behalf. */
  reportedByAdmin?: string;
}

export interface FileProductFeedbackResult {
  title: string;
  filed: FiledUserResult;
  replayed: boolean;
  issueId?: string;
  funnelStatusLabel?: string | null;
}

export async function fileProductFeedback(p: FileProductFeedbackParams): Promise<FileProductFeedbackResult> {
  const { user } = p;
  const description = p.description.trim();
  if (!description) throw new Error('Description is required');

  // The ONE normalization of the shared report title (ENG-529).
  const title = buildReportTitle(p.titlePrefix, description);
  const issueContext: Record<string, any> = {
    'User Name': user.displayName || user.email,
    'User Email': user.email,
    'User ID': user.userId,
    'Page URL': p.pageUrl || 'N/A',
    'Screenshot': p.screenshotContext ?? 'Not provided',
  };
  const funnelStatusLabel = getUserFunnelStatusLabel(user.funnelStatus);
  const funnelStatusTags = getUserFunnelStatusIssueTags(user.funnelStatus);
  if (funnelStatusLabel) issueContext['User Status'] = funnelStatusLabel;
  if (p.reportedByAdmin) issueContext['Reported By (Admin)'] = p.reportedByAdmin;

  const itemType: 'feature_request' | 'bug' = p.reportType === 'bug' ? 'bug' : 'feature_request';
  const { fileUserIssue } = await import('./intakeService');
  // ONE fingerprint, used twice on purpose (ENG-529 AC5 / ENG-598 option A): the in-process
  // replay guard and the durable destination-side lookup must share it.
  const fingerprint = reportFingerprint({
    userId: user.userId,
    reportType: p.reportType,
    description,
    pageUrl: p.pageUrl,
  });
  const outcome = await fileReportOnce(
    fingerprint,
    () => fileUserIssue({
      type: itemType,
      title,
      description,
      userEmail: user.email,
      userName: user.displayName || user.email,
      reportedByAdmin: p.reportedByAdmin,
      sessionId: p.sessionId,
      // ENG-1961: the dedup judge this filing runs is the caller's work, not "system".
      actingUserId: user.userId,
      reportFingerprint: fingerprint,
      funnelStatus: user.funnelStatus,
      notionTags: ['Customer Reported', p.tag, ...funnelStatusTags],
      notionContext: issueContext,
    }),
    Date.now(),
    REPORT_CAPACITY_WAIT_MS,
    user.userId,
  );
  const filed = outcome.result;
  return {
    title,
    filed,
    replayed: outcome.replayed,
    issueId: filed.pageId ? `AGW-${filed.pageId}` : undefined,
    funnelStatusLabel,
  };
}

/** Tracker tag/title prefix for the two feedback intents Emma can file deterministically. */
export const EMMA_FEEDBACK_INTENTS: Record<string, { tag: string; titlePrefix: string }> = {
  bug: { tag: 'Bug', titlePrefix: 'Bug' },
  feature_request: { tag: 'Feature Request', titlePrefix: 'Feature Request' },
};
