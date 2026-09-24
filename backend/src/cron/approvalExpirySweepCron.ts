/**
 * Approval Inbox Expiry Sweep (ENG-1644 gap-closing round)
 *
 * A durable decision that nobody ever answers just sat as
 * pending_team_review/pending_customer_response forever — claimDecision's
 * own atomic expiry check made it un-claimable past expiresAt, but nothing
 * ever flipped its status or told the origin session it went unanswered.
 * StatusExpiryIndex (status HASH, expiresAt RANGE) was provisioned in
 * create-tables.ts specifically for this and had zero consumers until now.
 *
 * Registered in server.ts to run hourly — decisions expire on a 1-7 day
 * horizon, hourly is far more granular than needed.
 */
import { approvalInboxService, type ApprovalDecision } from '../services/approvalInboxService';
import { notifyOriginSessionOfExpiry } from '../services/approvalInboxExecution';

const TAG = '[approvalExpirySweepCron]';

const DUE_PENDING_STATUSES = ['pending_team_review', 'pending_customer_response'] as const;

export interface ApprovalExpirySweepSummary {
  scanned: number;
  expired: number;
  alreadyResolved: number;
  failed: number;
}

async function processDueDecision(decision: ApprovalDecision, summary: ApprovalExpirySweepSummary): Promise<void> {
  try {
    const result = await approvalInboxService.expireDecision(decision.decisionId);
    if (!result.expired) {
      // A real claim (or a previous sweep tick) beat this one to it — not a
      // failure, just nothing left to do for this item.
      summary.alreadyResolved++;
      return;
    }
    summary.expired++;
    await notifyOriginSessionOfExpiry(result.decision);
  } catch (error) {
    summary.failed++;
    console.error(`${TAG} Failed to process decision ${decision.decisionId}:`, error);
  }
}

/**
 * Scans both pending statuses for decisions past expiresAt, flips each to
 * 'expired', and notifies its origin session. Resilient: a failure on one
 * decision never aborts the sweep for the rest.
 */
export async function runApprovalExpirySweep(): Promise<ApprovalExpirySweepSummary> {
  const summary: ApprovalExpirySweepSummary = { scanned: 0, expired: 0, alreadyResolved: 0, failed: 0 };

  for (const status of DUE_PENDING_STATUSES) {
    let dueDecisions: ApprovalDecision[];
    try {
      dueDecisions = await approvalInboxService.listDuePending(status);
    } catch (error) {
      console.error(`${TAG} Failed to query due decisions for status ${status}:`, error);
      continue;
    }
    summary.scanned += dueDecisions.length;
    for (const decision of dueDecisions) {
      await processDueDecision(decision, summary);
    }
  }

  if (summary.scanned > 0) {
    console.log(
      `${TAG} Run complete — scanned=${summary.scanned} expired=${summary.expired} ` +
        `alreadyResolved=${summary.alreadyResolved} failed=${summary.failed}`,
    );
  }
  return summary;
}
