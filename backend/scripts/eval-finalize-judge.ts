/**
 * ENG-185: finalize-guard judge-accuracy eval.
 *
 * Usage:
 *   npx ts-node backend/scripts/eval-finalize-judge.ts          # recorded judge (deterministic, no network)
 *   npx ts-node backend/scripts/eval-finalize-judge.ts --live   # REAL production judge prompt on gemini-3.1-flash-lite
 *   ... --json                                                  # raw report
 *
 * --live makes one small LLM call per case that passes the lexicon prefilter
 * (~30 calls, bounded cost) using the backend's configured LLM credentials.
 * It changes no flags or data. AGENT_FINALIZE_GUARD / _SHADOW stay a Harsha decision.
 */

import {
  formatJudgeAccuracyReport,
  recordedJudgeFor,
  scoreFinalizeJudge,
  type JudgeFn,
} from '../src/loops/eval/finalizeJudgeAccuracy';
import { FINALIZE_JUDGE_CASES } from '../src/loops/eval/finalizeJudgeAccuracyFixtures';
import { buildFinalizeJudgePrompt, parseFinalizeJudgeOutput, FINALIZE_JUDGE_MAX_COMPLETION_TOKENS } from '../src/services/agentMode/core/finalizeGuard';
import { toolResultError } from '../src/utils/toolResultError';
import { mediaGenProducedAsset } from '../src/services/agentMode/core/toolDispatch';

const JUDGE_MODEL = 'gemini-3.1-flash-lite';

async function liveJudge(): Promise<JudgeFn> {
  // Lazy import: only the opt-in live path loads the service + its config.
  const { agentModeService } = await import('../src/services/agentModeService');
  return async (finalText, candidates) => {
    const response = await (agentModeService as any).callLLM(JUDGE_MODEL, [
      { role: 'user', content: buildFinalizeJudgePrompt(finalText, candidates) },
    ], {
      max_completion_tokens: FINALIZE_JUDGE_MAX_COMPLETION_TOKENS,
      temperature: 0,
      taskClass: 'nonstandard_consumer',
      usageContext: { feature: 'finalize_guard_judge_eval' },
    });
    return parseFinalizeJudgeOutput((response as any)?.choices?.[0]?.message?.content);
  };
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const judge = live ? await liveJudge() : recordedJudgeFor(FINALIZE_JUDGE_CASES);
  const report = await scoreFinalizeJudge(FINALIZE_JUDGE_CASES, judge, { toolResultError, mediaGenProducedAsset });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`[${live ? `live ${JUDGE_MODEL}` : 'recorded'} judge]\n${formatJudgeAccuracyReport(report)}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
