/** Stored shapes of an approval card in a chat history: the halt message and the reply that answers it. */
import type { ApprovalDeckAnsweredBy, ApprovalDeckHistoryMessage } from '../../services/agentMode/core/approvalDeck';

export type DeckMessage = ApprovalDeckHistoryMessage;

export const deckHalt = (kind: string, deckId: string, question = 'q'): DeckMessage => ({
  metadata: { pendingApprovalDeckId: deckId, approvalDeckItems: [{ itemId: `item-${deckId}`, kind, question }] },
});

export const deckReply = (deckId: string, verdict: string, answeredBy: ApprovalDeckAnsweredBy, at: string): DeckMessage => ({
  metadata: { approvalDeckAnswer: { deckId, answers: [{ itemId: `item-${deckId}`, verdict, answeredBy, at }] } },
});
