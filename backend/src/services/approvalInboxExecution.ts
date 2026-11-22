import { chatbotDb } from './chatbotService';
import { approvalInboxService, type ApprovalDecision } from './approvalInboxService';
import { agentModeService } from './agentModeService';
// A service importing from the controller layer is an already-established
// pattern in this codebase (emmaEmailService.ts does the same), not a new
// direction — generateSessionResponse is the one place session-history
// fetch, runFunding resolution and the tool loop are already correctly
// wired; hand-assembling a smaller version of it here would risk missing
// one of those (runFunding especially has real, documented failure modes
// if skipped). tryClaimSessionGeneration/releaseSessionGeneration are the
// same lock scheduleAutoWorkPlanContinuation uses so this can't race a real,
// concurrently-running user turn on the same session.
import {
  generateSessionResponse,
  tryClaimSessionGeneration,
  releaseSessionGeneration,
} from '../controllers/agentModeController';

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

/** Shared by the passive-write fallback and the active-resume messageContent
 *  below — one source of truth for how a resolution reads, so the two paths
 *  can never describe the same event differently. */
function buildResolutionMessage(decision: ApprovalDecision): string {
  const verdictLabel =
    decision.verdict === 'approve' ? 'approved' : decision.verdict === 'reject' ? 'rejected' : 'sent back with a correction';
  // A 'system:<reason>' answeredBy (e.g. the customer_credential auto-resolve
  // path's 'system:auto-reconnect') is an internal attribution tag, not
  // something a human should read verbatim — humanize it (review fix).
  const approverLabel = decision.answeredBy?.startsWith('system:')
    ? `the system automatically (${decision.answeredBy.slice('system:'.length).replace(/-/g, ' ')})`
    : decision.answeredBy || decision.approver || 'the approver';

  return [
    `[Approval Inbox ${decision.decisionId}] ${approverLabel} ${verdictLabel} this decision.`,
    `Decision: ${decision.businessImpact}`,
    decision.freeText ? `Note from ${approverLabel}: "${decision.freeText}"` : '',
    decision.verdict === 'edit'
      ? 'Do not proceed with the original plan as-is — address the note above before continuing, and re-propose with the correction incorporated if this was a plan_choice.'
      : 'Use this as the resolved answer to continue this work.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Passive-only record — the ENG-1644 original behavior, kept as the fallback
 *  when an active resume (below) genuinely cannot run (no origin session, a
 *  real user turn already in flight, or the resume itself throwing). Never
 *  the primary path anymore for a session that CAN be resumed — a decision
 *  resolved via Slack days after the chat went quiet must not just sit as an
 *  unread note the agent may never come back to read (ENG-1853 Build item 4:
 *  "approval immediately resumes the originating agent"). Exported —
 *  sessionId-scoped rather than decision-scoped so the meta_write manifest
 *  executor (agentModeService.ts) can use the exact same fallback shape
 *  instead of a second copy that could drift. */
export async function recordPassiveSessionNote(sessionId: string, content: string): Promise<void> {
  // metadata is a strictly-typed, shared shape (chatbotService.ts's
  // ChatMessage) with no index signature — reuses only its existing generic
  // markers (kind/isContextMessage/timestamp) rather than adding
  // approval-inbox-specific fields to a type shared by every message
  // producer in the codebase. The decisionId/gateType/verdict correlators
  // that would otherwise live in metadata are in the content string above.
  await chatbotDb.addMessageToSession(sessionId, {
    role: 'system',
    content,
    metadata: {
      timestamp: new Date().toISOString(),
      isContextMessage: true,
      kind: 'approval-inbox-resolution',
    },
  });
}

/**
 * ENG-1853: actively resume a session's agent loop with messageContent as
 * the turn's input, rather than only leaving a passive note the session
 * might never come back to read. Mirrors scheduleAutoWorkPlanContinuation's
 * own shape exactly (same session-lock discipline, same "never fight a real
 * user turn" rule, same userMessageKind hide-from-UI tag) — that function is
 * the one other place in this codebase that already triggers a full agent
 * turn with no live request behind it, so this reuses its proven pattern
 * rather than inventing a second one.
 *
 * Exported and sessionId-scoped (not decision-scoped) — review fix: the
 * original decision-only shape left the meta_write manifest executor
 * (agentModeService.ts's executeApprovalInboxMetaWriteManifest) with no way
 * to resume the origin session at all once a whole packet finished
 * dispatching, which meant the flagship Haven/Every scenario this ticket was
 * built around never actually closed the loop — the turn message promised
 * "I'll resume automatically" and nothing did. Both the per-decision path
 * below and the manifest executor now share this one primitive.
 *
 * Falls back to recordPassiveSessionNote on any failure (session not found,
 * a real user turn already in flight, generateSessionResponse itself
 * throwing) — never throws; the resolution must always be recorded
 * SOMEWHERE even when the richer active-resume path can't run right now.
 */
export async function resumeOriginSession(sessionId: string, messageContent: string): Promise<void> {
  const session = await chatbotDb.getChatSessionRecord(sessionId).catch((err) => {
    console.warn('[approval-inbox-execution] failed to read origin session, falling back to a passive note:', sessionId, err?.message || err);
    return null;
  });
  if (!session) {
    await recordPassiveSessionNote(sessionId, messageContent);
    return;
  }

  if (!tryClaimSessionGeneration(sessionId, session.userId)) {
    console.warn(`[approval-inbox-execution] session ${sessionId} already generating — recording a passive note instead of actively resuming.`);
    await recordPassiveSessionNote(sessionId, messageContent);
    return;
  }

  try {
    const llmModel = session.llmModel || (await agentModeService.getDefaultModel());
    const resolved = await generateSessionResponse(
      sessionId,
      messageContent,
      session.userId,
      llmModel,
      undefined, // attachments
      undefined, // isInteractiveShare
      undefined, // pageContext
      undefined, // isDelegatedAccess
      undefined, // ishareSenderInfo
      undefined, // answerAck
      undefined, // answeredQuestionMeta
      undefined, // turnStartMs — no whole-turn deadline for this background resume
      undefined, // publishAuthorizationOverride
      undefined, // approvedRevisionImageSources
      // ENG-1239: tags this as server-authored, same as auto-continuation's
      // own 'auto-continuation' tag, so the chat UI hides the raw directive
      // as a turn rather than rendering it as if the customer typed it.
      'approval-inbox-resolution',
    );
    if (resolved?.content) {
      const { io } = await import('../server');
      io.to(`user:${session.userId}`).emit('session-message-appended', {
        sessionId,
        message: { role: 'assistant', content: resolved.content },
      });
    }
  } catch (err: any) {
    console.warn('[approval-inbox-execution] active resume failed, recording a passive note instead:', sessionId, err?.message || err);
    await recordPassiveSessionNote(sessionId, messageContent);
  } finally {
    releaseSessionGeneration(sessionId);
  }
}

/** Thin decision-scoped wrapper around resumeOriginSession — keeps every
 *  existing call site in this file unchanged. */
async function activelyResumeOriginSession(decision: ApprovalDecision, messageContent: string): Promise<void> {
  if (!decision.originSessionId) return;
  await resumeOriginSession(decision.originSessionId, messageContent);
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
    // ENG-1853: a meta_write decision's REAL dispatch happens once, at the
    // manifest level, once every item in the packet is resolved — not here,
    // per-item. Approving item 3 of Haven's 5 calls must not fire that one
    // write in isolation; the manifest-level orchestrator
    // (agentModeService.ts, built alongside buildMetaWriteWorkflowSteps) is
    // what actually calls dispatchAuthorizedMetaWrite, driven by the new
    // approve-all route once the whole manifest is ready. This only marks
    // the individual item as claimed-and-waiting — never a terminal outcome,
    // so it's never mistaken for "nothing will happen" the way the old
    // execution_failed stub was.
    //
    // Only an 'approve' verdict marks dispatching — claimDecision has
    // already set status to 'rejected'/'edited' for the other two verdicts,
    // and that's the correct terminal state for a write nobody approved.
    // Marking a REJECTED write 'dispatching' would tell the manifest
    // orchestrator to actually dispatch it, which is exactly the write the
    // reviewer just said no to.
    if (decision.verdict !== 'approve') return;
    try {
      await approvalInboxService.markDispatching(decision.decisionId);
    } catch (err: any) {
      console.warn('[approval-inbox-execution] failed to mark meta_write decision as dispatching:', decision.decisionId, err?.message || err);
    }
    return;
  }

  const messageContent = buildResolutionMessage(decision);
  try {
    await activelyResumeOriginSession(decision, messageContent);
    await approvalInboxService.recordExecutionResult(decision.decisionId, 'executed', {
      success: true,
      message: decision.originSessionId ? 'Origin session resumed with the resolution.' : 'No origin session to resume.',
      at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[approval-inbox-execution] failed to execute/resume for decision', decision.decisionId, err?.message || err);
    try {
      await approvalInboxService.recordExecutionResult(decision.decisionId, 'execution_failed', {
        success: false,
        message: err?.message || 'Failed to resume origin session.',
        at: new Date().toISOString(),
      });
    } catch (recordErr: any) {
      console.warn('[approval-inbox-execution] also failed to record the failure outcome:', recordErr?.message || recordErr);
    }
  }
}
