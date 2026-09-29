/**
 * ENG-2193 (ENG-2128 B): HumanEvalService.appendCreativeGateChecks — merges the async content
 * checks (OCR/spelling/brand-colour/logo/policy-keyword) onto an existing candidate's
 * `creativeGates`, mirroring `setCreativeRubric`/`setCreativePairwise`'s update-only contract
 * (see creativeRubricJudgeRuntime.test.ts's `HumanEvalService.setCreativeRubric` block for the
 * pattern this follows).
 */
import { HumanEvalService, type HumanEvalCandidate } from '../services/humanEvalService';
import { CREATIVE_GATES_GRADER_ID, CREATIVE_GATES_VERSION, type CreativeGateResult } from '../services/creativeGates';

function baseGates(overrides: Partial<CreativeGateResult> = {}): CreativeGateResult {
  return {
    graderId: CREATIVE_GATES_GRADER_ID,
    version: CREATIVE_GATES_VERSION,
    advisory: true,
    passed: true,
    checks: [{ id: 'decode', status: 'pass' }],
    bytes: 1234,
    fitsPlacements: [],
    evaluatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function fakeDb(candidate: HumanEvalCandidate | null) {
  const get = jest.fn().mockReturnValue({ promise: async () => ({ Item: candidate ?? undefined }) });
  const update = jest.fn((params: unknown) => ({ promise: async () => params }));
  return { get, update, put: jest.fn(), scan: jest.fn() };
}

describe('HumanEvalService.appendCreativeGateChecks', () => {
  it('merges the new checks onto the existing creativeGates.checks and keeps passed:true when nothing fails', async () => {
    const candidate = { candidateId: 'cand-1', creativeGates: baseGates() } as HumanEvalCandidate;
    const db = fakeDb(candidate);
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);

    await service.appendCreativeGateChecks('cand-1', [
      { id: 'spelling', status: 'pass' },
      { id: 'policy_keywords', status: 'skipped', reason: 'no text available to check' },
    ]);

    expect(db.update).toHaveBeenCalledWith({
      TableName: expect.stringMatching(/AW-HumanEvalQueue$/),
      Key: { candidateId: 'cand-1' },
      UpdateExpression: 'SET creativeGates = :gates',
      ConditionExpression: 'attribute_exists(candidateId)',
      ExpressionAttributeValues: {
        ':gates': {
          ...baseGates(),
          checks: [
            { id: 'decode', status: 'pass' },
            { id: 'spelling', status: 'pass' },
            { id: 'policy_keywords', status: 'skipped', reason: 'no text available to check' },
          ],
          passed: true,
        },
      },
    });
  });

  it('flips passed:false when an appended check fails, even though the structural checks all passed', async () => {
    const candidate = { candidateId: 'cand-1', creativeGates: baseGates() } as HumanEvalCandidate;
    const db = fakeDb(candidate);
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);

    await service.appendCreativeGateChecks('cand-1', [{ id: 'spelling', status: 'fail', reason: 'possibly misspelled word(s): recieve' }]);

    const written = (db.update.mock.calls[0][0] as { ExpressionAttributeValues: { ':gates': CreativeGateResult } })
      .ExpressionAttributeValues[':gates'];
    expect(written.passed).toBe(false);
    expect(written.checks).toHaveLength(2);
  });

  it('is a no-op when the candidate has no creativeGates yet', async () => {
    const candidate = { candidateId: 'cand-1' } as HumanEvalCandidate; // no creativeGates
    const db = fakeDb(candidate);
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);

    await service.appendCreativeGateChecks('cand-1', [{ id: 'spelling', status: 'pass' }]);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('is a no-op when the candidate does not exist', async () => {
    const db = fakeDb(null);
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);

    await service.appendCreativeGateChecks('missing', [{ id: 'spelling', status: 'pass' }]);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('is a no-op (never even reads the candidate) when there are no checks to append', async () => {
    const db = fakeDb({ candidateId: 'cand-1', creativeGates: baseGates() } as HumanEvalCandidate);
    const service = new HumanEvalService(db as unknown as ConstructorParameters<typeof HumanEvalService>[0]);

    await service.appendCreativeGateChecks('cand-1', []);

    expect(db.get).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
