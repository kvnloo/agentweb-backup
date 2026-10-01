/**
 * Tests for the approval-deck primitive's shape/verdict invariants added in
 * ENG-1635/1644 v2 (universal comment verdict, the recommended-option count
 * invariant, the 'comment' reserved-word guard). The higher-level dispatch/
 * grant/reconciliation behavior is covered elsewhere (metaWriteManifest*
 * suites); this file is scoped to appendApprovalDeckItem/applyDeckAnswers'
 * own validation rules, same scope askUserQuestion.test.ts has for its
 * sibling primitive.
 */

import {
  createApprovalDeck,
  appendApprovalDeckItem,
  finalizeApprovalDeck,
  applyDeckAnswers,
  approvedWriteItems,
  ApprovalDeckError,
  type ApprovalDeckItem,
} from '../approvalDeck';

function writeItem(itemId: string): ApprovalDeckItem {
  return {
    itemId,
    kind: 'meta_write',
    question: `Approve write ${itemId}?`,
    metaWriteManifestDigest: `digest-${itemId}`,
    metaWriteDispatch: { entity_type: 'AD', action: 'UPDATE', account_id: 'acct-1', params: {} },
  };
}

function optionItem(itemId: string, overrides: Partial<ApprovalDeckItem> = {}): ApprovalDeckItem {
  return {
    itemId,
    kind: 'plan_choice',
    question: 'Which objective?',
    options: [
      { id: 'leads', label: 'Leads', consequence: 'Optimizes for demos.', recommended: true, why: 'Pixel data.' },
      { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks.' },
    ],
    ...overrides,
  };
}

describe('approvalDeck — validateItemShape invariants (ENG-1635/1644 v2)', () => {
  it('rejects an option item with zero recommended options', () => {
    const deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    expect(() =>
      appendApprovalDeckItem(
        deck,
        optionItem('q-1', {
          options: [
            { id: 'leads', label: 'Leads', consequence: 'Optimizes for demos.' },
            { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks.' },
          ],
        }),
      ),
    ).toThrow(ApprovalDeckError);
  });

  it('rejects an option item with more than one recommended option', () => {
    const deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    expect(() =>
      appendApprovalDeckItem(
        deck,
        optionItem('q-1', {
          options: [
            { id: 'leads', label: 'Leads', consequence: 'Optimizes for demos.', recommended: true, why: 'Pixel data.' },
            { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks.', recommended: true, why: 'Also good.' },
          ],
        }),
      ),
    ).toThrow(ApprovalDeckError);
  });

  it('accepts an option item with exactly one recommended option', () => {
    const deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    expect(() => appendApprovalDeckItem(deck, optionItem('q-1'))).not.toThrow();
  });

  it("rejects an option whose id is the reserved word 'comment'", () => {
    const deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    expect(() =>
      appendApprovalDeckItem(
        deck,
        optionItem('q-1', {
          options: [
            { id: 'comment', label: 'Comment', consequence: 'x', recommended: true, why: 'y' },
            { id: 'traffic', label: 'Traffic', consequence: 'Cheap clicks.' },
          ],
        }),
      ),
    ).toThrow(ApprovalDeckError);
  });

  it('a write item never has its options checked for the recommended invariant (it carries no options at all)', () => {
    const deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    expect(() => appendApprovalDeckItem(deck, writeItem('write-1'))).not.toThrow();
  });
});

describe('approvalDeck — universal comment verdict (ENG-1635/1644 v2)', () => {
  function answeredWriteAndOptionDeck() {
    let deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    deck = appendApprovalDeckItem(deck, writeItem('write-1'));
    deck = appendApprovalDeckItem(deck, optionItem('q-1'));
    return finalizeApprovalDeck(deck, '2026-01-01T00:00:01.000Z');
  }

  it("accepts a 'comment' verdict on a write item, with non-empty freeText", () => {
    const deck = answeredWriteAndOptionDeck();
    const answered = applyDeckAnswers(
      deck,
      [
        { itemId: 'write-1', verdict: 'comment', freeText: 'What budget should this use?' },
        { itemId: 'q-1', verdict: 'leads' },
      ],
      'user',
      '2026-01-01T00:00:02.000Z',
    );
    expect(answered.answers?.find((a) => a.itemId === 'write-1')).toEqual(
      expect.objectContaining({ verdict: 'comment', freeText: 'What budget should this use?' }),
    );
  });

  it("accepts a 'comment' verdict on an option item, with non-empty freeText", () => {
    const deck = answeredWriteAndOptionDeck();
    const answered = applyDeckAnswers(
      deck,
      [
        { itemId: 'write-1', verdict: 'approve' },
        { itemId: 'q-1', verdict: 'comment', freeText: 'Why does this matter?' },
      ],
      'user',
      '2026-01-01T00:00:02.000Z',
    );
    expect(answered.answers?.find((a) => a.itemId === 'q-1')).toEqual(
      expect.objectContaining({ verdict: 'comment', freeText: 'Why does this matter?' }),
    );
  });

  it("rejects a 'comment' verdict with empty freeText — a comment with nothing said is meaningless", () => {
    const deck = answeredWriteAndOptionDeck();
    expect(() =>
      applyDeckAnswers(
        deck,
        [
          { itemId: 'write-1', verdict: 'comment' },
          { itemId: 'q-1', verdict: 'leads' },
        ],
        'user',
        '2026-01-01T00:00:02.000Z',
      ),
    ).toThrow(ApprovalDeckError);
  });

  it("a 'comment' verdict on a write item is not counted as approved (approvedWriteItems stays empty)", () => {
    const deck = answeredWriteAndOptionDeck();
    const answered = applyDeckAnswers(
      deck,
      [
        { itemId: 'write-1', verdict: 'comment', freeText: 'hold on' },
        { itemId: 'q-1', verdict: 'leads' },
      ],
      'user',
      '2026-01-01T00:00:02.000Z',
    );
    expect(approvedWriteItems(answered)).toEqual([]);
  });
});

describe('approvalDeck — per-item delegation (ENG-1635/1644 Phase 2f)', () => {
  function answeredWriteAndOptionDeck() {
    let deck = createApprovalDeck('deck-1', '2026-01-01T00:00:00.000Z');
    deck = appendApprovalDeckItem(deck, writeItem('write-1'));
    deck = appendApprovalDeckItem(deck, optionItem('q-1'));
    return finalizeApprovalDeck(deck, '2026-01-01T00:00:01.000Z');
  }

  it("a delegated item resolves to its recommended option, stamped answeredBy: 'delegation'", () => {
    const deck = answeredWriteAndOptionDeck();
    const answered = applyDeckAnswers(
      deck,
      [
        { itemId: 'write-1', verdict: 'approve' },
        { itemId: 'q-1', verdict: 'traffic', delegated: true }, // verdict must be ignored
      ],
      'user',
      '2026-01-01T00:00:02.000Z',
    );
    const q1Answer = answered.answers?.find((a) => a.itemId === 'q-1');
    // optionItem()'s recommended option is 'leads' — the delegated answer must
    // resolve to THAT, never the client-supplied (and ignored) 'traffic'.
    expect(q1Answer).toEqual(expect.objectContaining({ verdict: 'leads', answeredBy: 'delegation' }));
  });

  it('a submission can mix a directly-answered item and a delegated item — one answeredBy is not forced onto the whole batch', () => {
    const deck = answeredWriteAndOptionDeck();
    const answered = applyDeckAnswers(
      deck,
      [
        { itemId: 'write-1', verdict: 'approve' }, // direct
        { itemId: 'q-1', verdict: 'ignored', delegated: true }, // delegated
      ],
      'user',
      '2026-01-01T00:00:02.000Z',
    );
    expect(answered.answers?.find((a) => a.itemId === 'write-1')).toEqual(expect.objectContaining({ answeredBy: 'user' }));
    expect(answered.answers?.find((a) => a.itemId === 'q-1')).toEqual(expect.objectContaining({ answeredBy: 'delegation' }));
  });

  it('delegating a write item (no options, no recommended option) is rejected — a write has no "recommended option" concept', () => {
    const deck = answeredWriteAndOptionDeck();
    expect(() =>
      applyDeckAnswers(
        deck,
        [
          { itemId: 'write-1', verdict: 'approve', delegated: true },
          { itemId: 'q-1', verdict: 'leads' },
        ],
        'user',
        '2026-01-01T00:00:02.000Z',
      ),
    ).toThrow(ApprovalDeckError);
  });

  it('an explicit answeredBy of "user" for the submission is overridden to "delegation" ONLY on the delegated item, per-item', () => {
    const deck = answeredWriteAndOptionDeck();
    const answered = applyDeckAnswers(
      deck,
      [
        { itemId: 'write-1', verdict: 'reject' },
        { itemId: 'q-1', verdict: 'traffic', delegated: true },
      ],
      'user',
      '2026-01-01T00:00:02.000Z',
    );
    expect(answered.answers?.find((a) => a.itemId === 'write-1')?.answeredBy).toBe('user');
    expect(answered.answers?.find((a) => a.itemId === 'q-1')?.answeredBy).toBe('delegation');
  });
});
