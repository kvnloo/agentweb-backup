import {
  AI_LABEL_NOTE_PREFIX,
  buildCaseId,
  GOLDEN_CRITERIA,
  GoldenCaseValidationError,
  isAiLabelled,
  isFullyLabelled,
  newCreativePairCase,
  newGoldenCase,
  parseGoldenCase,
  parseLabelUpdate,
  splitForCaseId,
  TEST_SPLIT_FRACTION,
  MAX_NOTE_CHARS,
  PAIRWISE_CRITERION,
  type CreativePairRef,
} from '../loops/eval/goldenSet';

const NOW = new Date('2026-09-25T00:00:00.000Z');

function agentCase() {
  return newGoldenCase({ surface: 'agent', taskType: 'fp_catalogue', sourceId: 'session-1', seedSource: 'fp_catalogue:ENG-972', now: NOW });
}

describe('golden case schema (ENG-2135)', () => {
  it('builds a new case with the surface criteria, no labels and a deterministic split', () => {
    const c = agentCase();
    expect(c.caseId).toBe('agent#sessionId#session-1');
    expect(c.criteria).toEqual([
      'task_success',
      'tool_correctness',
      'groundedness',
      'instruction_compliance',
      'argued_with_instruction',
      'escalated_when_not_required',
      'failed_to_escalate',
    ]);
    expect(c.labels).toEqual({});
    expect(c.version).toBe(0);
    expect(c.split).toBe(splitForCaseId(c.caseId));
    expect(parseGoldenCase(c)).toEqual(c);
  });

  it('uses the ENG-421 seven criteria for creative and the three truth states for account health', () => {
    expect(GOLDEN_CRITERIA.creative).toEqual(['hook', 'offer', 'proof_integrity', 'brand_fidelity', 'format_readiness', 'policy_risk', 'buyer_usefulness']);
    expect(GOLDEN_CRITERIA.account_health).toEqual(['activation_incomplete', 'at_risk', 'healthy']);
  });

  it('rejects a criterion from another surface, a bad label value and a mismatched source kind', () => {
    expect(() => parseGoldenCase({ ...agentCase(), labels: { hook: 'pass' } })).toThrow(/not a agent criterion/);
    expect(() => parseGoldenCase({ ...agentCase(), labels: { task_success: 'yes' } })).toThrow(/pass, fail or na/);
    expect(() => parseGoldenCase({ ...agentCase(), sourceRef: { kind: 'userId', id: 'u1' } })).toThrow(/sourceRef.kind must be sessionId/);
    expect(() => parseGoldenCase({ ...agentCase(), surface: 'ads' })).toThrow(GoldenCaseValidationError);
    expect(() => parseGoldenCase({ ...agentCase(), split: 'train' })).toThrow(/split/);
    expect(() => parseGoldenCase({ ...agentCase(), version: -1 })).toThrow(/version/);
  });

  it('allows a replay link only on agent cases', () => {
    const creative = newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: 'cand-1', seedSource: 's', now: NOW });
    expect(() => parseGoldenCase({ ...creative, replay: { fixtureId: 'f', messageIndex: 1 } })).toThrow(/only valid on agent/);
    expect(parseGoldenCase({ ...agentCase(), replay: { fixtureId: 'f', messageIndex: 3 } }).replay).toEqual({ fixtureId: 'f', messageIndex: 3 });
    expect(() => parseGoldenCase({ ...agentCase(), replay: { fixtureId: 'f', messageIndex: -1 } })).toThrow(/messageIndex/);
  });

  it('reports fully labelled only when every criterion has a label (na counts)', () => {
    const c = agentCase();
    expect(isFullyLabelled(c)).toBe(false);
    const core = { task_success: 'pass', tool_correctness: 'na', groundedness: 'fail', instruction_compliance: 'pass' } as const;
    expect(isFullyLabelled({ ...c, labels: core })).toBe(false);
    const behaviours = { argued_with_instruction: 'fail', escalated_when_not_required: 'na', failed_to_escalate: 'pass' } as const;
    expect(isFullyLabelled({ ...c, labels: { ...core, ...behaviours } })).toBe(true);
  });

  it('validates a label update against the case surface', () => {
    expect(parseLabelUpdate('account_health', { labels: { at_risk: 'pass' }, notes: 'expired token', expectedVersion: 2 })).toEqual({
      labels: { at_risk: 'pass' },
      notes: 'expired token',
      expectedVersion: 2,
    });
    expect(() => parseLabelUpdate('account_health', { labels: { task_success: 'pass' }, expectedVersion: 0 })).toThrow(/not a account_health criterion/);
    expect(() => parseLabelUpdate('agent', { labels: {}, expectedVersion: 'x' })).toThrow(/expectedVersion/);
    expect(() => parseLabelUpdate('agent', { labels: {}, notes: 'x'.repeat(MAX_NOTE_CHARS + 1), expectedVersion: 0 })).toThrow(/notes/);
  });
});

describe('pairwise creative cases (ENG-2142)', () => {
  const PAIR: CreativePairRef = { candidateIdB: 'cand-b', batch: '2026-W39', position: 0, batchSize: 20, category: 'ad', placement: 'meta_feed_portrait', signal: 'uncertain' };
  const pairCase = () => newCreativePairCase({ candidateIdA: 'cand-a', pair: PAIR, now: NOW });

  it('builds a creative case over two candidates with the one pairwise criterion and no content', () => {
    const c = pairCase();
    expect(c).toMatchObject({
      caseId: 'creative#candidatePair#cand-a#cand-b',
      surface: 'creative',
      taskType: 'creative_pairwise',
      sourceRef: { kind: 'candidateId', id: 'cand-a' },
      criteria: [PAIRWISE_CRITERION],
      labels: {},
      seedSource: 'weekly_calibration:2026-W39',
      pair: PAIR,
    });
    expect(parseGoldenCase(c)).toEqual(c);
    expect(isFullyLabelled({ ...c, labels: { pairwise_preference: 'tie' } })).toBe(true);
  });

  it('takes A, B or tie on a pairwise case and nothing else', () => {
    for (const choice of ['A', 'B', 'tie']) {
      expect(parseGoldenCase({ ...pairCase(), labels: { pairwise_preference: choice } }).labels).toEqual({ pairwise_preference: choice });
      expect(parseLabelUpdate('creative', { labels: { pairwise_preference: choice }, expectedVersion: 0 }, true).labels).toEqual({ pairwise_preference: choice });
    }
    expect(() => parseLabelUpdate('creative', { labels: { pairwise_preference: 'pass' }, expectedVersion: 0 }, true)).toThrow(/A, B or tie/);
    expect(() => parseLabelUpdate('creative', { labels: { hook: 'pass' }, expectedVersion: 0 }, true)).toThrow(/not a pairwise creative criterion/);
    expect(() => parseGoldenCase({ ...pairCase(), criteria: ['hook'] })).toThrow(/not a pairwise creative criterion/);
  });

  it('keeps the pairwise criterion and A/B values off single cases', () => {
    const single = newGoldenCase({ surface: 'creative', taskType: 'creative_image', sourceId: 'cand-a', seedSource: 's', now: NOW });
    expect(() => parseLabelUpdate('creative', { labels: { pairwise_preference: 'A' }, expectedVersion: 0 })).toThrow(/not a creative criterion/);
    expect(() => parseLabelUpdate('creative', { labels: { hook: 'A' }, expectedVersion: 0 })).toThrow(/pass, fail or na/);
    expect(() => parseGoldenCase({ ...single, criteria: [PAIRWISE_CRITERION] })).toThrow(/not a creative criterion/);
  });

  it('rejects a pair on another surface, a pair of one creative with itself and a malformed pair', () => {
    expect(() => parseGoldenCase({ ...agentCase(), pair: PAIR })).toThrow(/only valid on creative/);
    expect(() => parseGoldenCase({ ...pairCase(), pair: { ...PAIR, candidateIdB: 'cand-a' } })).toThrow(/must differ/);
    expect(() => parseGoldenCase({ ...pairCase(), pair: { ...PAIR, signal: 'maybe' } })).toThrow(/pair.signal/);
    expect(() => parseGoldenCase({ ...pairCase(), pair: { ...PAIR, position: -1 } })).toThrow(/pair.position/);
    expect(() => parseGoldenCase({ ...pairCase(), pair: { ...PAIR, batch: '' } })).toThrow(/pair.batch/);
  });
});

describe('deterministic dev/test split', () => {
  it('depends on the case id alone and is stable across calls', () => {
    const ids = Array.from({ length: 50 }, (_, i) => buildCaseId('agent', { kind: 'sessionId', id: `s-${i}` }));
    expect(ids.map(splitForCaseId)).toEqual(ids.map(splitForCaseId));
  });

  it('puts roughly TEST_SPLIT_FRACTION of cases in test', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `creative#candidateId#c-${i}`);
    const test = ids.filter((id) => splitForCaseId(id) === 'test').length / ids.length;
    expect(Math.abs(test - TEST_SPLIT_FRACTION)).toBeLessThan(0.05);
  });

  it('pins known ids so a hashing change cannot silently reshuffle the split', () => {
    expect(['agent#sessionId#a', 'agent#sessionId#b', 'agent#sessionId#c', 'agent#sessionId#d'].map(splitForCaseId)).toEqual(['dev', 'dev', 'test', 'test']);
  });
});

describe('AI-written labels (ENG-2135)', () => {
  it('recognises a case whose note starts with the AI-label marker, and only that', () => {
    expect(AI_LABEL_NOTE_PREFIX).toBe('[AI-LABEL]');
    expect(isAiLabelled({ notes: `${AI_LABEL_NOTE_PREFIX} Written by Claude. Confidence: low.` })).toBe(true);
    expect(isAiLabelled({ notes: 'Looked fine to me. [AI-LABEL] is a marker used elsewhere' })).toBe(false);
    expect(isAiLabelled({ notes: '' })).toBe(false);
    expect(isAiLabelled({})).toBe(false);
  });
});
