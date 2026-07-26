/**
 * Tests for the AskUserQuestion primitive (ENG-396). The primitive is the
 * minimal chat gate that forces a human choice on an immutable parameter before
 * Emma builds — born from the RankAI LANDING_PAGE_VIEWS incident where Emma
 * defaulted an immutable Meta objective and self-approved its own confirm gate.
 *
 * Contract under test (see askUserQuestion.ts):
 *  - exactly ONE recommended option, with a one-line `why` (the product);
 *  - 2–4 options, unique ids, non-empty label + consequence;
 *  - answers are attributable to 'user' | 'delegation' ONLY — the model can
 *    never construct a valid answer (the core barrier);
 *  - an answered question cannot be re-answered (blocks the idx=205 same-turn
 *    re-issue class);
 *  - delegation resolves to the recommended option;
 *  - immutable questions never auto-take in headless mode.
 */

import {
  resolveRecommendedOptionId,
  buildPendingUserQuestion,
  applyAnswer,
  resolveInboundAnswer,
  selectedPayload,
  checkQuestionGate,
  renderQuestionPrompt,
  buildAnswerAcknowledgement,
  buildReaskDirective,
  AskUserQuestionError,
  type AskUserQuestionOption,
  type AskUserQuestionInput,
  type PendingUserQuestion,
} from '../askUserQuestion';

/** A valid 3-option set modeled on the actual incident objective choice. */
function objectiveOptions(): AskUserQuestionOption[] {
  return [
    {
      id: 'leads',
      label: 'Leads',
      consequence: 'Optimizes for the outcome you actually want (booked demos).',
      recommended: true,
      why: '162 LEAD events fired on your pixel in the last 30d; destination is a booking page.',
      payload: { objective: 'OUTCOME_LEADS', optimization_goal: 'OFFSITE_CONVERSIONS' },
    },
    {
      id: 'traffic',
      label: 'Traffic / Landing-page views',
      consequence: 'Cheap clicks and fast learning, but optimizes for visits, not leads.',
      payload: { objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LANDING_PAGE_VIEWS' },
    },
    {
      id: 'schedule',
      label: "Conversions — 'Schedule' event",
      consequence: 'Matches the booking CTA, but 0 fires to date; would stall in learning.',
      payload: { objective: 'OUTCOME_LEADS', optimization_goal: 'OFFSITE_CONVERSIONS' },
    },
  ];
}

function validInput(overrides: Partial<AskUserQuestionInput> = {}): AskUserQuestionInput {
  return {
    questionId: 'q-objective-1',
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: objectiveOptions(),
    immutable: true,
    allowEmmaDecide: true,
    createdAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function awaitingQuestion(overrides: Partial<AskUserQuestionInput> = {}): PendingUserQuestion {
  return buildPendingUserQuestion(validInput(overrides));
}

describe('resolveRecommendedOptionId — structural validation', () => {
  it('returns the single recommended option id on a valid set', () => {
    expect(resolveRecommendedOptionId(objectiveOptions())).toBe('leads');
  });

  it('FAIL: rejects fewer than 2 options', () => {
    const one = [objectiveOptions()[0]];
    expect(() => resolveRecommendedOptionId(one)).toThrow(AskUserQuestionError);
    expect(() => resolveRecommendedOptionId(one)).toThrow(/2–4 options/);
  });

  it('FAIL: rejects more than 4 options', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
      id,
      label: `L${id}`,
      consequence: `c${id}`,
      recommended: i === 0,
      why: i === 0 ? 'because' : undefined,
    }));
    expect(() => resolveRecommendedOptionId(five)).toThrow(/2–4 options/);
  });

  it('FAIL: rejects a non-array', () => {
    expect(() => resolveRecommendedOptionId(undefined as any)).toThrow(/2–4 options/);
  });

  it('FAIL: rejects zero recommended options', () => {
    const none = objectiveOptions().map((o) => ({ ...o, recommended: false, why: undefined }));
    expect(() => resolveRecommendedOptionId(none)).toThrow(/Exactly one option must be recommended, got 0/);
  });

  it('FAIL: rejects two recommended options', () => {
    const opts = objectiveOptions();
    opts[1].recommended = true;
    opts[1].why = 'also good';
    expect(() => resolveRecommendedOptionId(opts)).toThrow(/got 2/);
  });

  it('FAIL: rejects a recommended option missing its `why`', () => {
    const opts = objectiveOptions();
    delete opts[0].why;
    expect(() => resolveRecommendedOptionId(opts)).toThrow(/needs a one-line `why`/);
  });

  it('FAIL: rejects duplicate option ids', () => {
    const opts = objectiveOptions();
    opts[1].id = 'leads';
    expect(() => resolveRecommendedOptionId(opts)).toThrow(/Duplicate option id: leads/);
  });

  it('FAIL: rejects an empty option id', () => {
    const opts = objectiveOptions();
    opts[1].id = '   ';
    expect(() => resolveRecommendedOptionId(opts)).toThrow(/non-empty id/);
  });

  it('FAIL: rejects an empty label', () => {
    const opts = objectiveOptions();
    opts[1].label = '';
    expect(() => resolveRecommendedOptionId(opts)).toThrow(/non-empty label/);
  });

  it('FAIL: rejects an empty consequence', () => {
    const opts = objectiveOptions();
    opts[2].consequence = '';
    expect(() => resolveRecommendedOptionId(opts)).toThrow(/one-line consequence/);
  });
});

describe('buildPendingUserQuestion', () => {
  it('constructs an awaiting question with recommendedOptionId in sync', () => {
    const q = awaitingQuestion();
    expect(q.status).toBe('awaiting');
    expect(q.recommendedOptionId).toBe('leads');
    expect(q.immutable).toBe(true);
    expect(q.allowEmmaDecide).toBe(true);
    expect(q.answer).toBeUndefined();
  });

  it('defaults immutable and allowEmmaDecide to false when omitted', () => {
    const q = buildPendingUserQuestion(validInput({ immutable: undefined, allowEmmaDecide: undefined }));
    expect(q.immutable).toBe(false);
    expect(q.allowEmmaDecide).toBe(false);
  });

  it('FAIL: rejects a missing questionId', () => {
    expect(() => buildPendingUserQuestion(validInput({ questionId: '' }))).toThrow(/questionId is required/);
  });

  it('FAIL: rejects empty question text', () => {
    expect(() => buildPendingUserQuestion(validInput({ question: '   ' }))).toThrow(/question text is required/);
  });

  it('FAIL: propagates option validation errors', () => {
    const bad = objectiveOptions().map((o) => ({ ...o, recommended: false, why: undefined }));
    expect(() => buildPendingUserQuestion(validInput({ options: bad }))).toThrow(/Exactly one option/);
  });
});

describe('applyAnswer — the barrier', () => {
  it('SUCCESS: applies a direct user selection', () => {
    const q = awaitingQuestion();
    const answered = applyAnswer(q, {
      optionId: 'leads',
      delegated: false,
      answeredBy: 'user',
      at: '2026-07-21T00:01:00.000Z',
    });
    expect(answered.status).toBe('answered');
    expect(answered.answer).toEqual({
      optionId: 'leads',
      delegated: false,
      answeredBy: 'user',
      rationale: undefined,
      at: '2026-07-21T00:01:00.000Z',
    });
    // does not mutate the input
    expect(q.status).toBe('awaiting');
  });

  it('SUCCESS: applies a user selection of a NON-recommended option', () => {
    const answered = applyAnswer(awaitingQuestion(), {
      optionId: 'traffic',
      delegated: false,
      answeredBy: 'user',
      at: '2026-07-21T00:01:00.000Z',
    });
    expect(answered.answer?.optionId).toBe('traffic');
  });

  it('SUCCESS: applies a delegated answer resolving to the recommended option', () => {
    const answered = applyAnswer(awaitingQuestion(), {
      optionId: 'leads',
      delegated: true,
      answeredBy: 'delegation',
      rationale: 'User clicked "Let Emma decide"; taking the 162-LEAD-event recommendation.',
      at: '2026-07-21T00:01:00.000Z',
    });
    expect(answered.answer?.delegated).toBe(true);
    expect(answered.answer?.answeredBy).toBe('delegation');
    expect(answered.answer?.rationale).toMatch(/162-LEAD/);
  });

  it('FAIL: the model cannot answer — answeredBy other than user/delegation is rejected', () => {
    expect(() =>
      applyAnswer(awaitingQuestion(), {
        optionId: 'traffic',
        delegated: false,
        answeredBy: 'model' as any,
        at: '2026-07-21T00:01:00.000Z',
      }),
    ).toThrow(/Invalid answeredBy: model/);
  });

  it('FAIL: an already-answered question cannot be re-answered (blocks the idx=205 re-issue)', () => {
    const answered = applyAnswer(awaitingQuestion(), {
      optionId: 'leads',
      delegated: false,
      answeredBy: 'user',
      at: '2026-07-21T00:01:00.000Z',
    });
    expect(() =>
      applyAnswer(answered, {
        optionId: 'traffic',
        delegated: false,
        answeredBy: 'user',
        at: '2026-07-21T00:02:00.000Z',
      }),
    ).toThrow(/already answered/);
  });

  it('FAIL: rejects an unknown optionId', () => {
    expect(() =>
      applyAnswer(awaitingQuestion(), {
        optionId: 'nope',
        delegated: false,
        answeredBy: 'user',
        at: '2026-07-21T00:01:00.000Z',
      }),
    ).toThrow(/Unknown optionId: nope/);
  });

  it('FAIL: a delegated answer that is not the recommended option is rejected', () => {
    expect(() =>
      applyAnswer(awaitingQuestion(), {
        optionId: 'traffic',
        delegated: true,
        answeredBy: 'delegation',
        at: '2026-07-21T00:01:00.000Z',
      }),
    ).toThrow(/Delegated answers must select the recommended option/);
  });
});

describe('checkQuestionGate — the consumer guard (Option A safety, the scary cases)', () => {
  function answered(optionId = 'leads'): PendingUserQuestion {
    return applyAnswer(awaitingQuestion(), {
      optionId,
      delegated: false,
      answeredBy: 'user',
      at: '2026-07-21T00:01:00.000Z',
    });
  }

  it('ALLOWS a human-answered question and returns the deterministic payload', () => {
    const outcome = checkQuestionGate(answered('leads'), 'q-objective-1');
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) {
      expect(outcome.answer.answeredBy).toBe('user');
      expect(outcome.payload).toEqual({ objective: 'OUTCOME_LEADS', optimization_goal: 'OFFSITE_CONVERSIONS' });
    }
  });

  it('ALLOWS a delegation-answered question', () => {
    const delegated = applyAnswer(awaitingQuestion(), {
      optionId: 'leads',
      delegated: true,
      answeredBy: 'delegation',
      at: '2026-07-21T00:01:00.000Z',
    });
    expect(checkQuestionGate(delegated).allowed).toBe(true);
  });

  it('BLOCKS a direct write with no prior ask (no pending question)', () => {
    const outcome = checkQuestionGate(undefined);
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toMatch(/No question has been asked/);
  });

  it('BLOCKS the same-turn [ask, create] bundle — a same-turn ask can only be awaiting', () => {
    // The ask tool persists the question 'awaiting'; a create bundled in the
    // SAME turn sees exactly this state. It can never be 'answered' in-turn
    // because only a later user message flips it. This is the incident (idx=205).
    const outcome = checkQuestionGate(awaitingQuestion(), 'q-objective-1');
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toMatch(/awaiting a selection/);
  });

  it('BLOCKS a mismatched questionId (wrong correlation)', () => {
    const outcome = checkQuestionGate(answered('leads'), 'q-some-other-question');
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toMatch(/does not match the expected question/);
  });

  it('BLOCKS a forged non-human answer (defense in depth vs applyAnswer)', () => {
    // applyAnswer cannot construct this, but the guard must independently reject
    // any answer whose answeredBy is not user/delegation.
    const forged: PendingUserQuestion = {
      ...awaitingQuestion(),
      status: 'answered',
      answer: { optionId: 'traffic', delegated: false, answeredBy: 'model' as any, at: 'x' },
    };
    const outcome = checkQuestionGate(forged);
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toMatch(/not attributable to a human/);
  });

  it('accepts any answered question when no questionId is supplied', () => {
    expect(checkQuestionGate(answered('leads')).allowed).toBe(true);
  });

  // ── ENG-400: archive lookup (multi-question generalization) ──────────────
  it('ALLOWS via the archive when a LATER question has taken the live slot (earlier answer not lost)', () => {
    const earlier = answered('leads'); // questionId 'q-objective-1'
    const later = applyAnswer(
      buildPendingUserQuestion({
        questionId: 'q-later-2',
        question: 'A later, unrelated question',
        options: [
          { id: 'a', label: 'A', consequence: 'x', recommended: true, why: 'y' },
          { id: 'b', label: 'B', consequence: 'z' },
        ],
        createdAt: '2026-07-21T00:02:00.000Z',
      }),
      { optionId: 'a', delegated: false, answeredBy: 'user', at: '2026-07-21T00:03:00.000Z' },
    );
    // The live slot is now `later`; `earlier` only survives in the archive.
    const outcome = checkQuestionGate(later, 'q-objective-1', { 'q-objective-1': earlier });
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) {
      expect(outcome.answer.optionId).toBe('leads');
    }
  });

  it('BLOCKS when the requested questionId is in neither the live slot nor the archive', () => {
    const outcome = checkQuestionGate(answered('leads'), 'q-missing', { 'q-some-other-id': answered('traffic') });
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toMatch(/does not match the expected question/);
  });

  it('prefers the live slot over the archive when both would match', () => {
    const live = answered('traffic');
    const staleArchiveEntry = answered('leads');
    const outcome = checkQuestionGate(live, 'q-objective-1', { 'q-objective-1': staleArchiveEntry });
    expect(outcome.allowed).toBe(true);
    if (outcome.allowed) expect(outcome.answer.optionId).toBe('traffic');
  });
});

describe('renderQuestionPrompt — text fallback', () => {
  it('renders the question, numbered options, and marks the recommended one', () => {
    const text = renderQuestionPrompt(awaitingQuestion());
    expect(text).toContain('Which Meta campaign objective?');
    expect(text).toMatch(/1\. Leads —/);
    expect(text).toMatch(/⭐ Recommended: 162 LEAD events/);
    expect(text).toMatch(/Let Emma decide/); // allowEmmaDecide true → delegation footer
  });

  it('omits the delegation footer when allowEmmaDecide is false', () => {
    const text = renderQuestionPrompt(awaitingQuestion({ allowEmmaDecide: false }));
    expect(text).not.toMatch(/Let Emma decide/);
    expect(text).toMatch(/Pick an option above to continue/);
  });

  it('carries no instruction on how to answer (model cannot self-resolve)', () => {
    const text = renderQuestionPrompt(awaitingQuestion());
    expect(text).not.toMatch(/confirm\s*[:=]\s*true/i);
    expect(text.toLowerCase()).not.toMatch(/call .* again/);
  });

  it('prepends the optional intro (lead-in) above the question', () => {
    const q = awaitingQuestion({ intro: 'Pixel data is in (~200 LEAD/30d).' });
    const text = renderQuestionPrompt(q);
    expect(text.indexOf('Pixel data is in')).toBeLessThan(text.indexOf('Which Meta campaign objective?'));
  });

  it('buildPendingUserQuestion carries a trimmed intro, and drops an empty one', () => {
    expect(awaitingQuestion({ intro: '  Context here.  ' }).intro).toBe('Context here.');
    expect(awaitingQuestion({ intro: '   ' }).intro).toBeUndefined();
    expect(awaitingQuestion().intro).toBeUndefined();
  });
});

describe('selectedPayload — deterministic parameter apply', () => {
  it('returns the selected option payload once answered', () => {
    const answered = applyAnswer(awaitingQuestion(), {
      optionId: 'leads',
      delegated: false,
      answeredBy: 'user',
      at: '2026-07-21T00:01:00.000Z',
    });
    expect(selectedPayload(answered)).toEqual({
      objective: 'OUTCOME_LEADS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
    });
  });

  it('returns undefined while still awaiting', () => {
    expect(selectedPayload(awaitingQuestion())).toBeUndefined();
  });
});

describe('buildAnswerAcknowledgement — explicit in-response confirmation', () => {
  const AT = '2026-07-21T00:05:00.000Z';

  it('returns null while the question is still awaiting (nothing to acknowledge)', () => {
    expect(buildAnswerAcknowledgement(awaitingQuestion())).toBeNull();
  });

  it('a direct pick → names the selected option and asks Emma to confirm it', () => {
    const answered = resolveInboundAnswer(awaitingQuestion(), { optionId: 'traffic' }, AT);
    const ack = buildAnswerAcknowledgement(answered)!;
    expect(ack).toContain('selecting "Traffic / Landing-page views"');
    expect(ack).toMatch(/confirming "Traffic \/ Landing-page views" is now locked in/);
    // A direct pick is NOT framed as a delegation.
    expect(ack).not.toMatch(/Let Emma decide|let you decide/i);
  });

  it('a delegation → names Emma\'s recommended option, frames it as "you let me decide", includes the why', () => {
    const answered = resolveInboundAnswer(awaitingQuestion(), { delegated: true }, AT);
    const ack = buildAnswerAcknowledgement(answered)!;
    expect(ack).toContain('Let Emma decide');
    expect(ack).toContain('"Leads"'); // the recommended option
    expect(ack).toMatch(/let you decide/i);
    expect(ack).toContain('162 LEAD events'); // the recommended why, surfaced for the confirmation
  });
});

describe('buildReaskDirective — typed-past a card', () => {
  it('routes the acknowledgment into the card intro + asks for a tap, never resolves from text, re-asks', () => {
    const directive = buildReaskDirective(awaitingQuestion());
    expect(directive).toContain('Which Meta campaign objective');
    // acknowledgment must go in the card's `intro` (free prose next to a card is hidden)
    expect(directive).toMatch(/intro/);
    expect(directive).toMatch(/tap it/i);
    // but the text is never the answer / never self-resolved
    expect(directive).toMatch(/do NOT treat the typed message as the answer/i);
    expect(directive).toMatch(/do NOT\s+resolve it yourself/i);
    // still re-emits and waits for the click
    expect(directive).toMatch(/re-emit THAT SAME question|re-emit that same question/i);
    expect(directive).toMatch(/until they click/i);
  });
});

describe('resolveInboundAnswer — the /generate structured answer channel', () => {
  const AT = '2026-07-21T00:05:00.000Z';

  it('FAIL: rejects when there is no pending question', () => {
    expect(() => resolveInboundAnswer(null, { optionId: 'leads' }, AT)).toThrow(AskUserQuestionError);
    expect(() => resolveInboundAnswer(undefined, { optionId: 'leads' }, AT)).toThrow(/no pending question/i);
  });

  it('FAIL: rejects re-answering an already-answered question', () => {
    const answered = applyAnswer(awaitingQuestion(), {
      optionId: 'leads',
      delegated: false,
      answeredBy: 'user',
      at: AT,
    });
    expect(() => resolveInboundAnswer(answered, { optionId: 'traffic' }, AT)).toThrow(/already answered/i);
  });

  it('FAIL: rejects a questionId that does not match the pending question (stale card)', () => {
    expect(() =>
      resolveInboundAnswer(awaitingQuestion(), { questionId: 'q-stale', optionId: 'leads' }, AT),
    ).toThrow(/does not match/i);
  });

  it('FAIL: a direct selection with no optionId is rejected (a pick must name an option)', () => {
    expect(() => resolveInboundAnswer(awaitingQuestion(), { delegated: false }, AT)).toThrow(
      /must include an optionId/i,
    );
  });

  it('FAIL: a direct selection of an unknown optionId is rejected', () => {
    expect(() => resolveInboundAnswer(awaitingQuestion(), { optionId: 'nope' }, AT)).toThrow(
      /unknown optionId/i,
    );
  });

  it('resolves a direct user pick → answered by "user", never delegated', () => {
    const answered = resolveInboundAnswer(awaitingQuestion(), { questionId: 'q-objective-1', optionId: 'traffic' }, AT);
    expect(answered.status).toBe('answered');
    expect(answered.answer).toMatchObject({
      optionId: 'traffic',
      delegated: false,
      answeredBy: 'user',
      at: AT,
    });
    expect(answered.answer?.rationale).toBeUndefined();
  });

  it('resolves a delegation (no optionId) → takes the recommended option, answeredBy "delegation", with a logged rationale', () => {
    const answered = resolveInboundAnswer(awaitingQuestion(), { delegated: true }, AT);
    expect(answered.answer).toMatchObject({
      optionId: 'leads', // the recommended option
      delegated: true,
      answeredBy: 'delegation',
      at: AT,
    });
    expect(answered.answer?.rationale).toContain('162 LEAD events'); // the recommended why, logged
  });

  it('delegation IGNORES a client-supplied optionId and still resolves to the recommendation', () => {
    // A delegation click must never become a silent different choice, even if the
    // body carries a stray optionId — it always maps to the recommended option.
    const answered = resolveInboundAnswer(awaitingQuestion(), { delegated: true, optionId: 'traffic' }, AT);
    expect(answered.answer?.optionId).toBe('leads');
    expect(answered.answer?.answeredBy).toBe('delegation');
  });

  it('the resolved answer passes checkQuestionGate (end-to-end: selection → gate allows the consumer)', () => {
    const answered = resolveInboundAnswer(awaitingQuestion(), { optionId: 'leads' }, AT);
    const gate = checkQuestionGate(answered, 'q-objective-1');
    expect(gate.allowed).toBe(true);
    if (gate.allowed) {
      expect(gate.payload).toEqual({ objective: 'OUTCOME_LEADS', optimization_goal: 'OFFSITE_CONVERSIONS' });
    }
  });
});
