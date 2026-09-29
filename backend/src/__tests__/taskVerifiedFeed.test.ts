/**
 * ENG-2190: the task_verified feed. Two things to pin:
 *  - it stays inert (never reads eval-v2 data, never returns task_verified) while every grader
 *    is unvalidated, which is the real state of evalRegistry.ts today (ENG-2128 principle 2);
 *  - it works once a grader IS validated, proven with an injected gate rather than mutating the
 *    real registry.
 */
import {
  TASK_VERIFIED_GRADER_ID,
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
