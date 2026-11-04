/**
 * ENG-1635/1644 Phase 2 v3 — the question-deck producer and the generalized
 * iteration-end priority rule. Mirrors metaWriteManifestProducer.test.ts's
 * scope/style: unit-level tests against AgentModeService's private seam
 * methods (partitionApprovalHalts, buildQuestionApprovalDeckFromHalts,
 * buildApprovalDeckForIteration), not a full tool-registry/loop integration
 * test — present_question_deck's own execute() is a thin normalize-and-return
 * wrapper with no I/O and no branching beyond what's already covered here via
 * equivalently-shaped payloads.
 */

import { AgentModeService } from '../services/agentModeService';
import { approvalKindPrefix, computeApprovalDigest, newApprovalKind } from '../services/voice/hotLeadCallApprovalGate';

let service: AgentModeService;

beforeEach(() => {
  service = new AgentModeService();
});

function writeHalt(digest: string, detail = 'Update ad.') {
  return {
    awaitingUserConfirmation: true,
    metaWriteManifestDigest: digest,
    metaWriteDispatch: { entity_type: 'AD', action: 'UPDATE', account_id: 'acct-1', params: {} },
    confirmationDetail: detail,
  };
}

function questionDeckHalt(questions: Array<{ question: string; options?: any[] }>) {
  return {
    awaitingUserConfirmation: true,
    type: 'present_question_deck',
    questionDeckPayload: questions.map((q) => ({
      question: q.question,
      options: q.options ?? [
        { id: 'a', label: 'A', consequence: 'x', recommended: true, why: 'y' },
        { id: 'b', label: 'B', consequence: 'z' },
      ],
      allow_emma_decide: false,
    })),
  };
}

describe('ENG-1635/1644 Phase 2 — partitionApprovalHalts', () => {
  it('classifies a Meta-write-shaped halt into writeHalts', () => {
    const { writeHalts, questionDeckHalts, otherHalts } = (service as any).partitionApprovalHalts([
      { status: 'success', result: writeHalt('d1') },
    ]);
    expect(writeHalts).toHaveLength(1);
    expect(questionDeckHalts).toHaveLength(0);
    expect(otherHalts).toHaveLength(0);
  });

  it('classifies a present_question_deck-shaped halt into questionDeckHalts', () => {
    const { writeHalts, questionDeckHalts, otherHalts } = (service as any).partitionApprovalHalts([
      { status: 'success', result: questionDeckHalt([{ question: 'What budget?' }]) },
    ]);
    expect(writeHalts).toHaveLength(0);
    expect(questionDeckHalts).toHaveLength(1);
    expect(otherHalts).toHaveLength(0);
  });

  it('classifies an unrecognized awaitingUserConfirmation shape (e.g. ask_user_question, or a future halt type) into otherHalts', () => {
    const { writeHalts, questionDeckHalts, otherHalts } = (service as any).partitionApprovalHalts([
      { status: 'success', result: { awaitingUserConfirmation: true, type: 'ask_user_question', questionId: 'q-1' } },
    ]);
    expect(writeHalts).toHaveLength(0);
    expect(questionDeckHalts).toHaveLength(0);
    expect(otherHalts).toHaveLength(1);
  });

  it('ignores a non-halted (no awaitingUserConfirmation) success result entirely', () => {
    const { writeHalts, questionDeckHalts, otherHalts } = (service as any).partitionApprovalHalts([
      { status: 'success', result: { success: true, message: 'read-only, nothing to confirm' } },
    ]);
    expect(writeHalts).toHaveLength(0);
    expect(questionDeckHalts).toHaveLength(0);
    expect(otherHalts).toHaveLength(0);
  });
});

describe('ENG-1635/1644 Phase 2 — buildQuestionApprovalDeckFromHalts', () => {
  it('a single question (a "deck of one") is valid, mirroring the shipped solo-write precedent', () => {
    const deck = (service as any).buildQuestionApprovalDeckFromHalts([
      questionDeckHalt([{ question: 'What budget should this use?' }]),
    ]);
    expect(deck).not.toBeNull();
    expect(deck.items).toHaveLength(1);
    expect(deck.items[0].kind).toBe('plan_choice');
    expect(deck.status).toBe('awaiting');
  });

  it('front-loads multiple questions from ONE present_question_deck call into one deck', () => {
    const deck = (service as any).buildQuestionApprovalDeckFromHalts([
      questionDeckHalt([{ question: 'What objective?' }, { question: 'What budget?' }, { question: 'What audience?' }]),
    ]);
    expect(deck.items).toHaveLength(3);
    expect(deck.items.map((i: any) => i.question)).toEqual(['What objective?', 'What budget?', 'What audience?']);
  });

  it('merges questions across MULTIPLE present_question_deck halts in the same iteration into one deck', () => {
    const deck = (service as any).buildQuestionApprovalDeckFromHalts([
      questionDeckHalt([{ question: 'What objective?' }]),
      questionDeckHalt([{ question: 'What budget?' }]),
    ]);
    expect(deck.items).toHaveLength(2);
  });

  it('a malformed question (e.g. zero recommended options) falls back to null, same contract as the write-deck builder', () => {
    const deck = (service as any).buildQuestionApprovalDeckFromHalts([
      questionDeckHalt([{
        question: 'Bad question',
        options: [
          { id: 'a', label: 'A', consequence: 'x' },
          { id: 'b', label: 'B', consequence: 'y' },
        ],
      }]),
    ]);
    expect(deck).toBeNull();
  });

  it('returns null when no question-deck halts are present', () => {
    expect((service as any).buildQuestionApprovalDeckFromHalts([])).toBeNull();
  });
});

describe('ENG-2271 — one approval card per identical hot lead call change in a reply', () => {
  const digestA = computeApprovalDigest({ action: 'enable', orgId: 'o', userId: 'u', sessionId: 's', target: '{"enabled":true}', priceText: '$0.014 per minute', revision: 'r' });
  const digestB = computeApprovalDigest({ action: 'enable', orgId: 'o', userId: 'u', sessionId: 's', target: '{"enabled":true,"maxCallsPerHour":3}', priceText: '$0.014 per minute', revision: 'r' });
  const cardHalt = (digest: string) => ({
    awaitingUserConfirmation: true,
    type: 'ask_user_question',
    questionDeckPayload: [{
      question: 'Turn on hot lead calling?', kind: newApprovalKind('enable', digest), immutable: true, allowEmmaDecide: false,
      options: [{ id: 'decline', label: 'Decline', consequence: 'x', recommended: true, why: 'y' }, { id: 'approve', label: 'Turn calling on', consequence: 'z' }],
    }],
  });

  type Deck = { items: Array<{ kind: string }> };
  const buildDeck = (halts: unknown[]) => (service as unknown as { buildQuestionApprovalDeckFromHalts(h: unknown[]): Deck }).buildQuestionApprovalDeckFromHalts(halts);

  it('keeps one card when the reply made the same change twice', () => {
    const deck = buildDeck([cardHalt(digestA), cardHalt(digestA)]);
    expect(deck.items).toHaveLength(1);
    expect(deck.items[0].kind.startsWith(approvalKindPrefix('enable', digestA))).toBe(true);
  });
  it('keeps a card for each different change', () => {
    const deck = buildDeck([cardHalt(digestA), cardHalt(digestB), cardHalt(digestA)]);
    expect(deck.items.map(i => i.kind.split(':')[2])).toEqual([digestA, digestB]);
  });
  it('never merges questions that are not hot lead approval cards', () => {
    const deck = buildDeck([questionDeckHalt([{ question: 'Same?' }]), questionDeckHalt([{ question: 'Same?' }])]);
    expect(deck.items).toHaveLength(2);
  });
});

describe('ENG-1635/1644 Phase 2 v3 — buildApprovalDeckForIteration (the mixed-turn priority rule)', () => {
  it('a pure write turn builds a write deck with no droppedQuestionDeckPayload', () => {
    const deck = (service as any).buildApprovalDeckForIteration([writeHalt('d1')], []);
    expect(deck).not.toBeNull();
    expect(deck.items[0].kind).toBe('meta_write');
    expect(deck.droppedQuestionDeckPayload).toBeUndefined();
  });

  it('a pure question turn builds a question deck', () => {
    const deck = (service as any).buildApprovalDeckForIteration([], [questionDeckHalt([{ question: 'What budget?' }])]);
    expect(deck).not.toBeNull();
    expect(deck.items[0].kind).toBe('plan_choice');
  });

  it('a mixed turn (write + question-deck together) builds the WRITE deck and stashes the dropped questions', () => {
    const deck = (service as any).buildApprovalDeckForIteration(
      [writeHalt('d1')],
      [questionDeckHalt([{ question: 'What budget should this use?' }])],
    );
    expect(deck).not.toBeNull();
    expect(deck.items).toHaveLength(1);
    expect(deck.items[0].kind).toBe('meta_write');
    expect(deck.droppedQuestionDeckPayload).toHaveLength(1);
    expect(deck.droppedQuestionDeckPayload[0].question).toBe('What budget should this use?');
  });

  it('a mixed turn merges dropped questions from MULTIPLE question-deck halts', () => {
    const deck = (service as any).buildApprovalDeckForIteration(
      [writeHalt('d1')],
      [questionDeckHalt([{ question: 'Q1?' }]), questionDeckHalt([{ question: 'Q2?' }])],
    );
    expect(deck.droppedQuestionDeckPayload).toHaveLength(2);
  });

  it('neither bucket present returns null', () => {
    expect((service as any).buildApprovalDeckForIteration([], [])).toBeNull();
  });

  it('a write-deck build failure never falls through to silently build the question deck instead', () => {
    // partitionApprovalHalts always pairs a real digest with real dispatch
    // (see partitionApprovalHalts' own test above), so a write halt reaching
    // buildApprovalDeckForIteration is always well-formed in practice — this
    // proves the CONTRACT directly: if the write-deck build ever fails
    // (deck === null), the whole iteration must fall back to the old
    // plain-text prompt, never silently build the question deck instead
    // (which would let a write silently disappear behind a lower-priority
    // question — the exact failure mode gap 5 exists to prevent).
    const invalidWriteHalt = { ...writeHalt('d1') };
    delete (invalidWriteHalt as any).metaWriteDispatch;
    const deck = (service as any).buildApprovalDeckForIteration(
      [invalidWriteHalt],
      [questionDeckHalt([{ question: 'Q1?' }])],
    );
    expect(deck).toBeNull();
  });
});

describe('ENG-1635/1644 Phase 2g — extractMinimalToolResult preserves questionDeckPayload', () => {
  it('preserves questionDeckPayload on a present_question_deck halt (same class of bug as metaWriteManifestDigest/metaWriteDispatch, both already found live once)', () => {
    const raw = {
      success: true,
      awaitingUserConfirmation: true,
      type: 'present_question_deck',
      questionDeckPayload: [
        {
          question: 'What daily budget?',
          options: [
            { id: 'a', label: '$50/day', consequence: 'x', recommended: true, why: 'y' },
            { id: 'b', label: '$100/day', consequence: 'z' },
          ],
          allow_emma_decide: true,
        },
      ],
      confirmationPrompt: 'Review the following 1 question(s)...',
      summary: 'Review the following 1 question(s)...',
    };
    const minimized = (service as any).extractMinimalToolResult(raw, 'present_question_deck');
    expect(minimized.type).toBe('present_question_deck');
    expect(minimized.questionDeckPayload).toEqual(raw.questionDeckPayload);
    expect(minimized.awaitingUserConfirmation).toBe(true);
  });
});
