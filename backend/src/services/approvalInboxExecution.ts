import { chatbotDb } from './chatbotService';
import { approvalInboxService, type ApprovalDecision } from './approvalInboxService';

/**
 * ENG-1644 Phase D: what "executing" a resolved decision means, per gate
 * type. Channel-agnostic on purpose — called after a claim regardless of
 * whether the claim came from Slack (Phase C) or, eventually, a
 * customer-facing surface (Phase E), so both funnel through one place
 * rather than duplicating this logic per channel.
 *
 * Runs after EVERY terminal verdict (approve/reject/edit), not just
 * approve — mirrors humanEvalService.handleSlackThreadReply's
 * addFeedbackToSession pattern: Emma needs to know the outcome regardless
 * of which way it went, not just on approval.
 */

async function notifyOriginSession(decision: ApprovalDecision): Promise<void> {
  if (!decision.originSessionId) return;

  const verdictLabel =
    decision.verdict === 'approve' ? 'approved' : decision.verdict === 'reject' ? 'rejected' : 'sent back with a correction';
  const approverLabel = decision.answeredBy || decision.approver || 'the approver';

  const content = [
    `[Approval Inbox ${decision.decisionId}] ${approverLabel} ${verdictLabel} this decision.`,
    `Decision: ${decision.businessImpact}`,
    decision.freeText ? `Note from ${approverLabel}: "${decision.freeText}"` : '',
    decision.verdict === 'edit'
      ? 'Do not proceed with the original plan as-is — address the note above before continuing, and re-propose with the correction incorporated if this was a plan_choice.'
      : 'Use this as the resolved answer to continue this work.',
  ]
    .filter(Boolean)
    .join('\n');

  // metadata is a strictly-typed, shared shape (chatbotService.ts's
  // ChatMessage) with no index signature — reuses only its existing generic
  // markers (kind/isContextMessage/timestamp) rather than adding
  // approval-inbox-specific fields to a type shared by every message
  // producer in the codebase. The decisionId/gateType/verdict correlators
  // that would otherwise live in metadata are in the content string above.
  await chatbotDb.addMessageToSession(decision.originSessionId, {
    role: 'system',
    content,
    metadata: {
      timestamp: decision.answeredAt || new Date().toISOString(),
      isContextMessage: true,
      kind: 'approval-inbox-resolution',
    },
  });
}

/**
 * Called by approvalExpirySweepCron once a decision has been atomically
 * flipped to 'expired' (nobody answered it in time) — tells the origin
 * session explicitly rather than leaving it silently unresolved forever.
 * Self-contained (own try/catch, never throws) since the cron calls this
 * directly, not through executeResolvedDecision's wrapper.
 */
export async function notifyOriginSessionOfExpiry(decision: ApprovalDecision): Promise<void> {
  if (!decision.originSessionId) return;

  const approverLabel = decision.approver || (decision.audience === 'customer' ? 'the customer' : 'the approver');
  const content = [
    `[Approval Inbox ${decision.decisionId}] This decision expired with no answer from ${approverLabel}.`,
    `Decision: ${decision.businessImpact}`,
    'Do not assume this was approved or rejected — nobody answered it in time. Re-raise it if it still matters, or proceed without it if it no longer does.',
  ].join('\n');

  try {
    await chatbotDb.addMessageToSession(decision.originSessionId, {
      role: 'system',
      content,
      metadata: {
        timestamp: new Date().toISOString(),
        isContextMessage: true,
        kind: 'approval-inbox-resolution',
      },
    });
  } catch (err: any) {
    console.warn('[approval-inbox-execution] failed to notify origin session of expiry for decision', decision.decisionId, err?.message || err);
  }
}

export async function executeResolvedDecision(decision: ApprovalDecision): Promise<void> {
  if (decision.gateType === 'meta_write') {
    // No producer exists yet — stage_pending_decision explicitly refuses
    // meta_write (see its own file comment: the digest/dispatch fields are
    // internal-only and never model-visible), and nothing else in
    // production calls approvalInboxService.createDecision with this gate
    // type. A decision reaching this branch could only have been
    // constructed by calling that method directly. Recorded rather than
    // silently ignored, so an approved-but-never-dispatched write is never
    // mistaken for a closed loop once a real producer exists (separate,
    // already-flagged future work — see initiative-eng-1644-phase-a in the
    // brain).
    try {
      await approvalInboxService.recordExecutionResult(decision.decisionId, 'execution_failed', {
        success: false,
        message: 'meta_write dispatch is not implemented — no producer exists yet that can create a meta_write decision in production.',
        at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn('[approval-inbox-execution] failed to record meta_write no-op outcome:', err?.message || err);
    }
    return;
  }

  try {
    await notifyOriginSession(decision);
    await approvalInboxService.recordExecutionResult(decision.decisionId, 'executed', {
      success: true,
      message: decision.originSessionId ? 'Origin session notified of the resolution.' : 'No origin session to notify.',
      at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[approval-inbox-execution] failed to execute/notify for decision', decision.decisionId, err?.message || err);
    try {
      await approvalInboxService.recordExecutionResult(decision.decisionId, 'execution_failed', {
        success: false,
        message: err?.message || 'Failed to notify origin session.',
        at: new Date().toISOString(),
      });
    } catch (recordErr: any) {
      console.warn('[approval-inbox-execution] also failed to record the failure outcome:', recordErr?.message || recordErr);
    }
  }
}
