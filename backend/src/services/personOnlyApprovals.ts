/**
 * ENG-2962: approval cards that only a person may approve.
 *
 * Some of Emma's actions reach real people outside AgentWeb: adding contacts to a Smartlead campaign (or releasing them so
 * AgentWeb's own senders may email them again), placing a hot-lead call, activating a CRM email sequence, and creating a paused Meta
 * campaign bundle. Their gates already insist that the approval was a person's (`answeredBy === 'user'`), and refuse delegation.
 *
 * The hole: an outside agent on Emma's MCP server can answer a card with `emma_answer_question_deck`, which posts the answer to
 * `/api/agent-mode/generate` through a self-call. That answer was recorded as `'user'`, so an agent could approve its own action
 * (reproduced on the test environment 2026-11-12 with a Smartlead release). Self-calls carry `_svc` in their login token, which only
 * `mcpFetch` mints, so the generate route knows the answer did not come from a person.
 *
 * This module says which answers in a submission would approve one of those actions. A self-call may still decline them, comment,
 * or answer any other card.
 */
import type { InboundDeckAnswer, PendingApprovalDeck } from './agentMode/core/approvalDeck';
import { SMARTLEAD_APPROVAL_KIND_PREFIX } from './smartleadPushApprovalGate';
import { APPROVAL_KIND_RESERVED_PREFIX as HOT_LEAD_CALL_KIND_PREFIX, APPROVE_OPTION_ID } from './voice/hotLeadCallApprovalGate';
import { ACTIVATION_KIND_PREFIX, ACTIVATE_OPTION_ID } from './crmSequenceActivationGate';

/** What a card is, for the refusal message. */
export type PersonOnlyAction = 'smartlead' | 'hot_lead_call' | 'crm_sequence_activation' | 'meta_paused_bundle';

type DeckItem = PendingApprovalDeck['items'][number];

function personOnlyActionOf(item: DeckItem): { action: PersonOnlyAction; approvingVerdict: string } | null {
  const kind = typeof item.kind === 'string' ? item.kind : '';
  if (kind.startsWith(SMARTLEAD_APPROVAL_KIND_PREFIX)) return { action: 'smartlead', approvingVerdict: APPROVE_OPTION_ID };
  if (kind.startsWith(HOT_LEAD_CALL_KIND_PREFIX)) return { action: 'hot_lead_call', approvingVerdict: APPROVE_OPTION_ID };
  if (kind === ACTIVATION_KIND_PREFIX || kind.startsWith(`${ACTIVATION_KIND_PREFIX}:`)) return { action: 'crm_sequence_activation', approvingVerdict: ACTIVATE_OPTION_ID };
  if (item.metaWriteDispatch?.action === 'CREATE_PAUSED_BUNDLE') return { action: 'meta_paused_bundle', approvingVerdict: 'approve' };
  return null;
}

/**
 * The person-only cards that this submission would approve. Declines, comments and delegations are not counted (the gates refuse a
 * delegated approval anyway), and answers to other cards are never counted.
 */
export function personOnlyApprovalsIn(deck: PendingApprovalDeck | undefined | null, answers: unknown): Array<{ itemId: string; action: PersonOnlyAction }> {
  if (!deck || !Array.isArray(deck.items) || !Array.isArray(answers)) return [];
  const found: Array<{ itemId: string; action: PersonOnlyAction }> = [];
  for (const item of deck.items) {
    const gated = personOnlyActionOf(item);
    if (!gated) continue;
    for (const raw of answers as InboundDeckAnswer[]) {
      if (!raw || raw.itemId !== item.itemId || raw.delegated === true) continue;
      if (raw.verdict === gated.approvingVerdict) found.push({ itemId: item.itemId, action: gated.action });
    }
  }
  return found;
}

/** The refusal an MCP caller gets, written for the person it will relay it to. */
export function personOnlyRefusal(chatUrl: string): string {
  return 'This needs your approval in AgentWeb: an agent cannot approve it for you. Nothing was done. ' +
    `Open ${chatUrl} and choose on the card there.`;
}
