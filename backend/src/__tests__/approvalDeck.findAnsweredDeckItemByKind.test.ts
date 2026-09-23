/**
 * ENG-1635/1644 (ask_user_question retirement) — findAnsweredDeckItemByKind,
 * the deck primitive's sibling to askUserQuestion.ts's findQuestionByKind.
 * Pure function: scans already-fetched session messages for a halt message's
 * approvalDeckItems paired with a later reply's approvalDeckAnswer, matching
 * on `kind`. Used by resolveCampaignObjectiveGate's Path 2 "already settled"
 * check (agentModeService.metaObjectiveGate.test.ts covers that integration;
 * this covers the pure scan logic directly).
 */
import { findAnsweredDeckItemByKind, type ApprovalDeckHistoryMessage } from '../services/agentMode/core/approvalDeck';

function haltMessage(deckId: string, kind: string, itemId = 'item-1'): ApprovalDeckHistoryMessage {
  return {
    metadata: {
      pendingApprovalDeckId: deckId,
      approvalDeckItems: [
        {
          itemId,
          kind,
          question: 'Which objective?',
          options: [
            { id: 'leads', label: 'Leads', consequence: 'x', recommended: true, why: 'y' },
            { id: 'traffic', label: 'Traffic', consequence: 'z' },
          ],
        },
      ],
    },
  };
}

function replyMessage(deckId: string, itemId = 'item-1', verdict = 'leads', answeredBy: 'user' | 'delegation' = 'user') {
  return {
    metadata: {
      approvalDeckAnswer: {
        deckId,
        answers: [{ itemId, verdict, answeredBy, at: '2026-09-17T00:00:00.000Z' }],
      },
    },
  };
}

describe('findAnsweredDeckItemByKind', () => {
  it('finds an answered item by exact kind match', () => {
    const messages = [haltMessage('deck-1', 'meta_objective:123|test|||NONE'), replyMessage('deck-1')];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:123|test|||NONE');
    expect(outcome.found).toBe(true);
    if (outcome.found) {
      expect(outcome.item.itemId).toBe('item-1');
      expect(outcome.answer.verdict).toBe('leads');
      expect(outcome.answer.answeredBy).toBe('user');
    }
  });

  it('resolves a delegated answer just the same', () => {
    const messages = [haltMessage('deck-1', 'meta_objective:123|test|||NONE'), replyMessage('deck-1', 'item-1', 'traffic', 'delegation')];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:123|test|||NONE');
    expect(outcome.found).toBe(true);
    if (outcome.found) expect(outcome.answer.answeredBy).toBe('delegation');
  });

  it('does NOT match a different kind (correlator-scoped, same as findQuestionByKind)', () => {
    const messages = [haltMessage('deck-1', 'meta_objective:123|test|||NONE'), replyMessage('deck-1')];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:999|other|||NONE');
    expect(outcome.found).toBe(false);
  });

  it('does NOT match when the deck was never answered (halt only, no reply)', () => {
    const messages = [haltMessage('deck-1', 'meta_objective:123|test|||NONE')];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:123|test|||NONE');
    expect(outcome.found).toBe(false);
  });

  it('does NOT match a reply whose deckId points at a DIFFERENT deck (stale/mismatched pairing)', () => {
    const messages = [haltMessage('deck-1', 'meta_objective:123|test|||NONE'), replyMessage('deck-2')];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:123|test|||NONE');
    expect(outcome.found).toBe(false);
  });

  it('ignores messages with no deck metadata at all', () => {
    const messages: ApprovalDeckHistoryMessage[] = [{ metadata: null }, { metadata: {} }];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:123|test|||NONE');
    expect(outcome.found).toBe(false);
  });

  it('finds the correct deck among several unrelated ones in history', () => {
    const messages = [
      haltMessage('deck-a', 'meta_objective:111|a|||NONE'),
      replyMessage('deck-a'),
      haltMessage('deck-b', 'meta_objective:222|b|||NONE'),
      replyMessage('deck-b', 'item-1', 'traffic'),
    ];
    const outcome = findAnsweredDeckItemByKind(messages, 'meta_objective:222|b|||NONE');
    expect(outcome.found).toBe(true);
    if (outcome.found) expect(outcome.answer.verdict).toBe('traffic');
  });
});
