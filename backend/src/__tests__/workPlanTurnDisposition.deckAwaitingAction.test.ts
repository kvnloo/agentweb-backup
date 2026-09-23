/**
 * ENG-1635/1644 (ask_user_question retirement) — snapshotWorkPlanTurn's new
 * 'deck' awaitingAction branch, the sibling of its existing 'question' branch
 * (which read session.pendingUserQuestion; ask_user_question no longer
 * populates that field at all). Scoped narrowly to a single-item, non-write
 * pendingApprovalDeck — the exact shape ask_user_question/the objective gate
 * now build.
 */
import { snapshotWorkPlanTurn } from '../services/agentMode/core/workPlanTurnDisposition';

const baseSession = { workPlan: { steps: [] } };

describe('snapshotWorkPlanTurn — deck-of-one awaitingAction', () => {
  it('reports a deck-of-one as awaitingAction kind "deck"', () => {
    const snapshot = snapshotWorkPlanTurn({
      ...baseSession,
      pendingApprovalDeck: {
        deckId: 'deck-1',
        status: 'awaiting',
        items: [{ itemId: 'item-1', kind: 'meta_objective', question: 'Which objective?' }],
      },
    });
    expect(snapshot.awaitingAction).toEqual({ kind: 'deck', id: 'deck-1' });
  });

  it('input still takes priority over a simultaneously-awaiting deck', () => {
    const snapshot = snapshotWorkPlanTurn({
      ...baseSession,
      pendingWorkPlanInput: { requestId: 'req-1', status: 'awaiting' },
      pendingApprovalDeck: {
        deckId: 'deck-1',
        status: 'awaiting',
        items: [{ itemId: 'item-1', kind: 'meta_objective', question: 'Which objective?' }],
      },
    });
    expect(snapshot.awaitingAction).toEqual({ kind: 'input', id: 'req-1' });
  });

  it('legacy pendingUserQuestion still takes priority over a deck (both slots, transition window)', () => {
    const snapshot = snapshotWorkPlanTurn({
      ...baseSession,
      pendingUserQuestion: { questionId: 'q-1', status: 'awaiting' },
      pendingApprovalDeck: {
        deckId: 'deck-1',
        status: 'awaiting',
        items: [{ itemId: 'item-1', kind: 'meta_objective', question: 'Which objective?' }],
      },
    });
    expect(snapshot.awaitingAction).toEqual({ kind: 'question', id: 'q-1' });
  });

  it('does NOT report a multi-item deck as awaitingAction (out of scope)', () => {
    const snapshot = snapshotWorkPlanTurn({
      ...baseSession,
      pendingApprovalDeck: {
        deckId: 'deck-1',
        status: 'awaiting',
        items: [
          { itemId: 'item-1', kind: 'plan_choice', question: 'Budget?' },
          { itemId: 'item-2', kind: 'plan_choice', question: 'Audience?' },
        ],
      },
    });
    expect(snapshot.awaitingAction).toBeUndefined();
  });

  it('does NOT report a Meta-write deck-of-one as awaitingAction (out of scope)', () => {
    const snapshot = snapshotWorkPlanTurn({
      ...baseSession,
      pendingApprovalDeck: {
        deckId: 'deck-1',
        status: 'awaiting',
        items: [{ itemId: 'item-1', kind: 'meta_write', question: 'Create campaign', metaWriteManifestDigest: 'd1' }],
      },
    });
    expect(snapshot.awaitingAction).toBeUndefined();
  });

  it('does NOT report a deck that is not status "awaiting"', () => {
    const snapshot = snapshotWorkPlanTurn({
      ...baseSession,
      pendingApprovalDeck: {
        deckId: 'deck-1',
        status: 'answered',
        items: [{ itemId: 'item-1', kind: 'meta_objective', question: 'Which objective?' }],
        answers: [{ itemId: 'item-1', verdict: 'leads', answeredBy: 'user', at: 't' }],
      },
    });
    expect(snapshot.awaitingAction).toBeUndefined();
  });

  it('reports no awaitingAction when nothing is pending at all', () => {
    const snapshot = snapshotWorkPlanTurn(baseSession);
    expect(snapshot.awaitingAction).toBeUndefined();
    expect(snapshot.hasWorkPlan).toBe(true);
  });
});
