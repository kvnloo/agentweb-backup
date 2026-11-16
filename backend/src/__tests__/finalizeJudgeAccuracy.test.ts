/**
 * ENG-185: deterministic (recorded-judge) run of the finalize-guard
 * judge-accuracy eval. The live judge run is opt-in:
 *   npx ts-node backend/scripts/eval-finalize-judge.ts --live
 */

import { CLAIM_CLASSES } from '../services/agentMode/core/finalizeGuard';
import {
  formatJudgeAccuracyReport,
  recordedJudgeFor,
  scoreFinalizeJudge,
  type JudgeAccuracyCase,
} from '../loops/eval/finalizeJudgeAccuracy';
import { FINALIZE_JUDGE_CASES } from '../loops/eval/finalizeJudgeAccuracyFixtures';
import { toolResultError } from '../utils/toolResultError';
import { mediaGenProducedAsset } from '../services/agentMode/core/toolDispatch';

describe('finalize-guard judge accuracy eval (ENG-185)', () => {
  it('fixture set meets the coverage contract: >=30 cases, every class has mismatch + backed + ambiguous/adversarial', () => {
    expect(FINALIZE_JUDGE_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(FINALIZE_JUDGE_CASES.map((c) => c.id)).size).toBe(FINALIZE_JUDGE_CASES.length);
    for (const cls of CLAIM_CLASSES) {
      const touching = FINALIZE_JUDGE_CASES.filter((c) => c.recordedJudge.some((j) => j.claimClass === cls));
      expect(touching.some((c) => c.expectedMismatch.includes(cls))).toBe(true);
      expect(touching.some((c) => c.kind === 'true_backed')).toBe(true);
      expect(touching.some((c) => c.kind === 'ambiguous_loose' || c.kind === 'adversarial')).toBe(true);
    }
    expect(FINALIZE_JUDGE_CASES.filter((c) => c.kind === 'adversarial').length).toBeGreaterThanOrEqual(5);
  });

  it('scores precision/recall/FPR correctly on a hand-computed set', async () => {
    const cases: JudgeAccuracyCase[] = [
      { id: 'tp', kind: 'true_mismatch', finalText: 'I emailed Dana.', ledger: [], expectedMismatch: ['email_sent'], recordedJudge: [{ claimClass: 'email_sent', statement: 'email sent' }] },
      { id: 'fp', kind: 'true_backed', finalText: 'The email was sent.', ledger: [], expectedMismatch: [], recordedJudge: [{ claimClass: 'email_sent', statement: 'email sent' }] },
      { id: 'fn', kind: 'adversarial', finalText: 'It is in her inbox.', ledger: [], expectedMismatch: ['email_sent'], recordedJudge: [{ claimClass: 'email_sent', statement: 'email sent' }] },
      { id: 'tn', kind: 'true_backed', finalText: 'Email sent to Bo.', ledger: [{ toolName: 'send_email', status: 'success', result: {} }], expectedMismatch: [], recordedJudge: [{ claimClass: 'email_sent', statement: 'email sent' }] },
    ];
    const r = await scoreFinalizeJudge(cases, recordedJudgeFor(cases));
    expect(r.perClass.email_sent).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5, falsePositiveRate: 0.5 });
    expect(r.failures.map((f) => f.id).sort()).toEqual(['fn', 'fp']);
  });

  it('counts a throwing judge as a judge error (guard delivers unchanged, no prediction)', async () => {
    const cases = FINALIZE_JUDGE_CASES.slice(0, 1);
    const r = await scoreFinalizeJudge(cases, async () => { throw new Error('timeout'); });
    expect(r.judgeErrors).toBe(1);
    expect(r.results[0].predicted).toEqual([]);
  });

  it('recorded-judge run is deterministic and matches the production ports', async () => {
    const judge = recordedJudgeFor(FINALIZE_JUDGE_CASES);
    const fixturePorts = await scoreFinalizeJudge(FINALIZE_JUDGE_CASES, judge);
    const prodPorts = await scoreFinalizeJudge(FINALIZE_JUDGE_CASES, judge, { toolResultError, mediaGenProducedAsset });
    const again = await scoreFinalizeJudge(FINALIZE_JUDGE_CASES, judge);
    expect(again).toEqual(fixturePorts);
    expect(prodPorts.overall).toEqual(fixturePorts.overall);
    // eslint-disable-next-line no-console
    console.log(formatJudgeAccuracyReport(fixturePorts));
    // Pin current numbers so a matcher/lexicon change that moves them is visible in review.
    expect(fixturePorts.judgeErrors).toBe(0);
    expect(fixturePorts.overall.fp).toBe(0);
    expect(fixturePorts.failures.map((f) => f.id)).toEqual(['multi-email-and-draft-post', 'adv-lexicon-miss']);
  });
});
