import type { ToolContext } from './orgCaller';
import { hotLeadCallRevisionOf } from '../services/hotLeadCallSettingsService';
import * as approval from '../services/voice/hotLeadCallApprovalGate';
import type { Organization } from '../services/db';
import type { ApprovalDeckHistoryMessage } from '../services/agentMode/core/approvalDeck';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The person the tool acts for; part of what an approval is bound to. */
export function userIdOf(context: ToolContext): string {
  return String(context?.userId || context?.agentUserId);
}

/**
 * Runs after every other check. Returns a halt (the approval card) unless the user already approved this exact
 * action in this chat; in that case the approval is claimed (single use) and the caller may act. A claim that
 * is lost, or a crash after it, costs the approval and never allows a second action.
 * Used by the paid number tools (hotLeadCallSetupTools.ts) and by turning calling on (hotLeadCallTools.ts).
 */
export async function requireApproval(p: {
  org: Organization; context: ToolContext; target: string | null; priceText: string;
  /** The action and what its card says; the wording itself is built by the gate. */
  card: DistributiveOmit<approval.ApprovalQuestionInput, 'kind' | 'priceText'>;
}): Promise<Record<string, unknown> | undefined> {
  const { context, priceText, card } = p;
  const requestedSessionId = typeof context?.sessionId === 'string' ? context.sessionId : undefined;
  const { chatbotDb } = await import('../services/chatbotService');
  const readSession = requestedSessionId ? await chatbotDb.getChatSession(requestedSessionId, true).catch(() => null) : null;
  const attended = approval.checkAttendedForApproval({
    unattended: context?.isUnattendedRun === true,
    delegated: context?.isDelegatedAccess === true || context?.isDelegatedAdmin === true,
    sessionId: requestedSessionId,
    session: readSession,
  });
  if (!attended.allowed) throw new Error(attended.reason);
  const { sessionId, session } = attended;

  const digest = approval.computeApprovalDigest({
    action: card.action, orgId: p.org.orgId, userId: userIdOf(context), sessionId,
    target: p.target, priceText, revision: hotLeadCallRevisionOf(p.org.hotLeadCall),
  });
  // The history comes from the consistent session read above, so a fresh decline cannot be missed.
  const messages: ApprovalDeckHistoryMessage[] = session.messages;
  const consumedKinds = new Set(Object.keys(session.consumedMetaWriteManifestDigests ?? {})
    .filter(k => k.startsWith(approval.CONSUMED_KEY_PREFIX)).map(k => k.slice(approval.CONSUMED_KEY_PREFIX.length)));
  const found = approval.findApproval(messages, approval.approvalKindPrefix(card.action, digest), Date.now(), consumedKinds);

  if (found.status === 'none') {
    const question = approval.buildApprovalQuestion({ ...card, kind: approval.newApprovalKind(card.action, digest), priceText });
    return {
      success: true,
      awaitingUserConfirmation: true,
      type: 'ask_user_question',
      sessionId,
      questionDeckPayload: [question],
      confirmationPrompt: question.question,
      summary: question.question,
      message: 'Nothing was done yet. The run stops here until the user answers the card. After they approve, call this tool again with the same arguments; do not ask them in text.',
    };
  }
  if (!(await chatbotDb.claimMetaWriteManifestDigest(sessionId, approval.consumedKeyOf(found.kind)))) {
    throw new Error('This approval was already used. Nothing was done; ask again to get a new approval card.');
  }
  return undefined;
}
