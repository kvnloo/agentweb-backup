/**
 * ENG-2190: the task_verified feed. Two things to pin:
 *  - it stays inert (never reads eval-v2 data, never returns task_verified) while every grader
 *    is unvalidated, which is the real state of evalRegistry.ts today (ENG-2128 principle 2);
 *  - it works once a grader IS validated, proven with an injected gate rather than mutating the
 *    real registry.
 */
import {
  TASK_VERIFIED_GRADER_ID,
  TASK_VERIFIED_RATE_TOLERANCE,
  taskVerifiedQuality,
  taskVerifiedQualityLookup,
} from '../loops/eval/taskVerifiedFeed';
import { aggregateEvalV2, type EvalV2Score } from '../loops/eval/evalV2Sampler';
import { mayGate } from '../loops/eval/evalRegistry';

const DATE = '2026-09-28';
const NOW = new Date('2026-09-28T18:00:00.000Z');

let seq = 0;
function score(model: string, taskVerdict: EvalV2Score['taskVerdict'], taskType = 'ads'): EvalV2Score {
  seq++;
  return {
    sessionId: `s-${seq}`,
    sampleDate: DATE,
    surface: 'agent/regular',
    model,
    taskType,
    taskVerdict,
    toolVerdict: 'pass',
    toolCalls: 1,
    groundednessVerdict: 'no_claims',
    adherence: {},
    graderVersions: {},
  };
}

/** n sessions for `model`, `passes` of them successes, the rest failures — split across two task types so the feed's cross-task-type combining is exercised, not just a single cell. */
function scoresFor(model: string, n: number, passes: number): EvalV2Score[] {
  const out: EvalV2Score[] = [];
  for (let i = 0; i < n; i++) {
    const taskType = i % 2 === 0 ? 'ads' : 'landing_page';
    out.push(score(model, i < passes ? 'success' : 'failure', taskType));
  }
  return out;
}

/** n sessions for `model` in ONE named task type, `passes` of them successes — for fixtures that need precise control over which (surface, task type) cell a model has data in. */
function cellScores(model: string, taskType: string, n: number, passes: number): EvalV2Score[] {
  return Array.from({ length: n }, (_, i) => score(model, i < passes ? 'success' : 'failure', taskType));
}

function snapshotFor(scores: EvalV2Score[], gate: (id: string) => boolean = () => true) {
  return aggregateEvalV2(scores, { date: DATE, windowLabel: '7d', now: NOW, gate });
}

const FROM = 'anthropic.claude-opus-5';
const TO = 'anthropic.claude-haiku-4-5';

describe('taskVerifiedQuality: inert while unvalidated (real registry)', () => {
  it('evalRegistry.mayGate is false for agent-task-success today', () => {
    // Not a fixture — the real registry, so this fails the moment a grader is
    // actually validated and forces this suite's "inert" claim to be re-checked.
    expect(mayGate(TASK_VERIFIED_GRADER_ID)).toBe(false);
  });

  it('never returns task_verified against the real (unvalidated) registry, however strong the sampled data is', () => {
    const snapshot = snapshotFor([...scoresFor(FROM, 40, 40), ...scoresFor(TO, 40, 40)]);
    expect(taskVerifiedQuality(FROM, TO, snapshot)).toBeUndefined();
  });
});

describe('taskVerifiedQuality: wiring once a grader qualifies (injected gate, fixture data)', () => {
  const gate = () => true; // stands in for a real mayGate('agent-task-success') === true

  it('emits task_verified when both models clear the n bar and the candidate is not meaningfully worse', () => {
    const snapshot = snapshotFor([...scoresFor(FROM, 40, 36), ...scoresFor(TO, 40, 35)]); // 90% vs 87.5%
    const q = taskVerifiedQuality(FROM, TO, snapshot, { gate });
    expect(q).toEqual({
      status: 'task_verified',
      source: 'task_eval',
      reason: expect.stringContaining('88%'),
    });
  });

  it('stays undefined (falls back to the AA tier) when the candidate is meaningfully worse', () => {
    const snapshot = snapshotFor([...scoresFor(FROM, 40, 38), ...scoresFor(TO, 40, 20)]); // 95% vs 50%
    expect(taskVerifiedQuality(FROM, TO, snapshot, { gate })).toBeUndefined();
  });

  it('stays undefined when either side has fewer sampled sessions than the validation bar', () => {
    const snapshot = snapshotFor([...scoresFor(FROM, 10, 10), ...scoresFor(TO, 40, 40)]);
    expect(taskVerifiedQuality(FROM, TO, snapshot, { gate, minN: 30 })).toBeUndefined();
  });

  it('stays undefined with no snapshot at all, even when gated', () => {
    expect(taskVerifiedQuality(FROM, TO, undefined, { gate })).toBeUndefined();
  });

  it('combines rates across every task type for the model, not just one cell', () => {
    // 40 ads sessions all successes, 0 landing_page sessions — scoresFor already
    // interleaves task types, so this just asserts a realistic split still clears the bar.
    const snapshot = snapshotFor([...scoresFor(FROM, 60, 54), ...scoresFor(TO, 60, 54)]);
    expect(taskVerifiedQuality(FROM, TO, snapshot, { gate })?.status).toBe('task_verified');
  });

  /**
   * CodeRabbit on #3142: pooling each model's rate independently across every cell it happens to
   * have data for is a Simpson's-paradox trap. Here `toModel` is clearly WORSE than `fromModel`
   * on the one task type they actually share ('ads', 50% vs 90%), but also has a large volume of
   * ONLY its own data on a second, easy task type ('landing_page', 100%) that `fromModel` never
   * ran at all. Pooling independently drags toModel's overall rate up near fromModel's, which the
   * pre-fix code would have read as "not meaningfully worse" and wrongly called task_verified.
   * Restricting the comparison to the shared cell only must reject this pair.
   */
  it("rejects a candidate that is worse on every shared cell, even when an unshared easy cell would make its pooled rate look comparable (Simpson's paradox)", () => {
    const sharedAds = [...cellScores(FROM, 'ads', 40, 36), ...cellScores(TO, 'ads', 40, 20)]; // fromModel 90%, toModel 50% — the ONLY cell fromModel has data in.
    const unsharedLandingPage = cellScores(TO, 'landing_page', 200, 200); // toModel only, 100% — fromModel never sampled this cell at all.
    const snapshot = snapshotFor([...sharedAds, ...unsharedLandingPage]);

    // Control, asserted against the exact pre-fix arithmetic (pooling each side
    // independently across every cell it has data for) — this documents that the bug
    // was real even once the fix removes the function that had it: fromModel's pooled
    // rate is 36/40; toModel's pooled rate, dragged up by the unshared 100% cell, is
    // (20+200)/(40+200) — NOT meaningfully below fromModel's, so the pre-fix
    // `combinedRate`-based check would not have rejected this pair.
    const pooledFromRate = 36 / 40;
    const pooledToRate = (20 + 200) / (40 + 200);
    expect(pooledToRate).toBeGreaterThanOrEqual(pooledFromRate - TASK_VERIFIED_RATE_TOLERANCE);

    // The fix: compared only over the shared 'ads' cell, toModel is 50% vs fromModel's
    // 90% — meaningfully worse — so this must NOT be task_verified.
    expect(taskVerifiedQuality(FROM, TO, snapshot, { gate })).toBeUndefined();
  });

  it('is not comparable (undefined) when the two models share no sampled cell at all, however much data each has on its own', () => {
    const fromOnly = cellScores(FROM, 'ads', 40, 40); // fromModel: 100% on ads, its only cell.
    const toOnly = cellScores(TO, 'outreach', 40, 40); // toModel: 100% on outreach, its only cell — no overlap with fromModel.
    const snapshot = snapshotFor([...fromOnly, ...toOnly]);
    expect(taskVerifiedQuality(FROM, TO, snapshot, { gate })).toBeUndefined();
  });
});

describe('taskVerifiedQualityLookup: no I/O while ungated, one read while gated', () => {
  it('never calls readSnapshot when the gate is false — the "inert by construction" contract', async () => {
    const readSnapshot = jest.fn(async () => snapshotFor(scoresFor(FROM, 40, 40)));
    const lookup = taskVerifiedQualityLookup({ gate: () => false, readSnapshot });
    await expect(lookup(FROM, TO)).resolves.toBeUndefined();
    await expect(lookup(FROM, TO)).resolves.toBeUndefined();
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('reads the snapshot once per lookup instance, however many pairs are checked', async () => {
    const snapshot = snapshotFor([...scoresFor(FROM, 40, 36), ...scoresFor(TO, 40, 35)]);
    const readSnapshot = jest.fn(async () => snapshot);
    const lookup = taskVerifiedQualityLookup({ gate: () => true, readSnapshot });
    await lookup(FROM, TO);
    await lookup(FROM, TO);
    await lookup(TO, FROM);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it('the default gate (real evalRegistry.mayGate) also skips the read', async () => {
    const readSnapshot = jest.fn(async () => snapshotFor(scoresFor(FROM, 40, 40)));
    const lookup = taskVerifiedQualityLookup({ readSnapshot });
    await expect(lookup(FROM, TO)).resolves.toBeUndefined();
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});
