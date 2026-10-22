/** Stored shapes of an approval card in a chat history: the halt message and the reply that answers it. */
export type DeckMessage = { metadata: Record<string, unknown> };

export const deckHalt = (kind: string, deckId: string, question = 'q'): DeckMessage => ({
  metadata: { pendingApprovalDeckId: deckId, approvalDeckItems: [{ itemId: `item-${deckId}`, kind, question }] },
});

export const deckReply = (deckId: string, verdict: string, answeredBy: string, at: string): DeckMessage => ({
  metadata: { approvalDeckAnswer: { deckId, answers: [{ itemId: `item-${deckId}`, verdict, answeredBy, at }] } },
});
