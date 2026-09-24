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
// approvalInboxExecution.ts (imported above) already transitively pulls in
// chatbotService.ts, so this adds no new heavy import chain to this file.
import { upsertApproverQueueMessage, postDecisionExpiredNotice } from '../services/approvalInboxSlack';
import { notifyCustomerOfExpiredCredentialDecision } from '../services/approvalInboxCustomerNotify';

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
    // Review fix: every other resolution path (resolveApprovalDecision,
    // approvalInboxSlack.ts) refreshes the approver's Slack queue message so
    // a resolved item's buttons disappear immediately — the expiry path was
    // the one exception, leaving a stale message with live, now-nonfunctional
    // Approve/Reject/Edit buttons for a decision that's no longer claimable.
    // Best-effort — a Slack refresh failure must never fail the sweep.
    if (result.decision.approver) {
      try {
        await upsertApproverQueueMessage(result.decision.approver);
      } catch (slackErr) {
        console.warn(`${TAG} Failed to refresh Slack queue after expiring decision ${decision.decisionId}:`, slackErr);
      }
      // Review fix: the queue refresh above is a silent edit (chat.update)
      // — an approver can't tell "this expired" apart from "someone else
      // claimed it" from that alone. A real, always-new message, same
      // reasoning as postDecisionAddedNotice.
      try {
        await postDecisionExpiredNotice(result.decision.approver, result.decision);
      } catch (slackErr) {
        console.warn(`${TAG} Failed to post expiry notice for decision ${decision.decisionId}:`, slackErr);
      }
    } else if (result.decision.gateType === 'customer_credential') {
      // Review fix: a customer-audience decision has no approver/Slack
      // presence at all — without this, expiry was completely silent for
      // the customer, who only ever got the one creation-time email.
      try {
        await notifyCustomerOfExpiredCredentialDecision(result.decision);
      } catch (notifyErr) {
        console.warn(`${TAG} Failed to notify customer of expiry for decision ${decision.decisionId}:`, notifyErr);
      }
    }
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
    // listDuePending caps at Limit:100 with no pagination — self-healing
    // (the next hourly tick picks up whatever's left), but a silent partial
    // run reads identically to a complete one in the summary log unless
    // flagged (review fix).
    if (dueDecisions.length >= 100) {
      console.warn(`${TAG} Hit the 100-item cap for status ${status} — backlog likely exceeds this tick, remainder deferred to next run.`);
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
