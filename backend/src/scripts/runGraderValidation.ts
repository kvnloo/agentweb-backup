/**
 * Validate one eval-registry grader against the golden set's test split (ENG-2135).
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/runGraderValidation.ts <graderId> [--evidence <url>] [--split dev|test] [--include-ai-labels]
 *
 * Labels an AI wrote (note starts with [AI-LABEL]) are left out: agreement with them is not human agreement.
 * --include-ai-labels adds them for an advisory run, which never produces a registry-eligible validation record.
 *
 * Needs EVAL_GOLDEN_CASES_TABLE (OPS-2 / ENG-2147). Read-only: prints the per-criterion
 * agreement report and the `validation` record as JSON. It never edits evalRegistry.ts; to let
 * a grader gate, record the printed validation there in a reviewed PR with --evidence set to
 * the published run.
 */

import { goldenSetStoreFromEnv, GOLDEN_CASES_TABLE_ENV } from '../loops/eval/goldenSetStore';
import { defaultGoldenCaseGraders, MIN_CLASS_EXAMPLES, runValidation } from '../loops/eval/runValidation';
import { getGrader, isQualifyingValidation } from '../loops/eval/evalRegistry';
import type { GoldenSplit } from '../loops/eval/goldenSet';

async function main(): Promise<void> {
  const [graderId, ...rest] = process.argv.slice(2);
  if (!graderId) throw new Error('usage: runGraderValidation.ts <graderId> [--evidence <url>] [--split dev|test] [--include-ai-labels]');
  let evidence: string | undefined;
  let split: GoldenSplit = 'test';
  let includeAiLabels = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--evidence') evidence = rest[++i];
    else if (rest[i] === '--split' && (rest[i + 1] === 'dev' || rest[i + 1] === 'test')) split = rest[++i] as GoldenSplit;
    else if (rest[i] === '--include-ai-labels') includeAiLabels = true;
    else throw new Error(`unknown argument ${rest[i]}`);
  }

  const store = goldenSetStoreFromEnv();
  if (!store.isProvisioned()) {
    console.error(`Golden-set store not provisioned: set ${GOLDEN_CASES_TABLE_ENV} (OPS-2 / ENG-2147).`);
    process.exit(1);
  }
  const run = await runValidation({
    graderId,
    store,
    // LLM judges cost a call per case: build them only when one is the grader being validated.
    graders: defaultGoldenCaseGraders({ llmJudges: getGrader(graderId)?.graderType === 'llm_judge' }),
    evidence,
    split,
    includeAiLabels,
  });
  console.log(JSON.stringify(run, null, 2));
  if (run.labelSource === 'human+ai') {
    console.log(`${graderId}: ADVISORY — includes ${run.aiLabelledCases} AI-written label(s); not human agreement and not a registry-eligible validation (mayGate stays false).`);
    return;
  }
  if (run.aiLabelledCases > 0) console.log(`${run.aiLabelledCases} AI-written label(s) in the ${split} split were left out (--include-ai-labels adds them for an advisory run).`);
  const primary = run.criteria.find((c) => c.criterion === run.primaryCriterion);
  if (run.validation && isQualifyingValidation(run.validation)) {
    console.log(`${graderId}: meets the registry bar on ${run.primaryCriterion} — record it in evalRegistry.ts via a reviewed PR.`);
  } else if (primary && primary.report && !primary.reliable) {
    console.log(`${graderId}: ${run.primaryCriterion} has only ${primary.minorityN} example(s) of its rarer class (needs ${MIN_CLASS_EXAMPLES}); no validation record produced — mayGate stays false.`);
  } else {
    console.log(`${graderId}: does not meet the registry bar (or has no evidence link) — mayGate stays false.`);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('runGraderValidation failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
