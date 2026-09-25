/**
 * Score existing AW-HumanEvalQueue creatives with the creative rubric judge (ENG-2140), offline.
 *
 * Usage:
 *   npx ts-node src/scripts/scoreCreativeRubric.ts --ids <candidateId,...> [--pairwise] [--model <id>] [--dry-run]
 *
 * READ-ONLY. It reads the candidates (AW-HumanEvalQueue; Dev- prefixed when NODE_ENV=development),
 * the account brand profile and the images, and prints verdicts. It writes nothing: the result is
 * not stored on the candidate, and the judge is called on OpenRouter directly rather than through
 * `AgentModeService.callLLM`, whose usage metering would write spend-ledger rows. The OpenRouter
 * key comes from OPENROUTER_API_KEY or the `<env>/AgentWeb/OpenRouter` secret, as for callLLM.
 *
 * Output is verdicts only (pass/fail per criterion, pass counts, error kinds, token usage): never
 * the ad copy, the generation request, the rationale text or image URLs, so it can be pasted into
 * a PR or ticket.
 *
 *   --pairwise  also compare each candidate with the prior best creative for the same account and
 *               placement (selectPriorBest) and report the win rate of the newer creative.
 *   --dry-run   call no model; report which judge inputs each candidate has and the estimated cost.
 */
import { argv, exit } from 'node:process';
import { pairwiseWinRate, type PairwiseChoice } from '../loops/eval/agreement';
import {
  DEFAULT_RUBRIC_JUDGE_MODEL,
  RUBRIC_CRITERIA,
  brandProfileFromBrandData,
  judgeCreative,
  judgeCreativePair,
  readChatCompletion,
  type CreativeBrief,
  type RubricJudgeLlm,
} from '../services/creativeRubricJudge';
import { RUBRIC_SYSTEM_PROMPT } from '../services/creativeRubricJudgePrompt';
import { placementFromGates, selectPriorBest } from '../services/creativeRubricJudgeRuntime';
import type { HumanEvalCandidate } from '../services/humanEvalService';
import { getModelPrice } from '../utils/llmPricing';

interface Args {
  ids: string[];
  pairwise: boolean;
  dryRun: boolean;
  model: string;
}

function parseArgs(raw: readonly string[]): Args {
  const args: Args = { ids: [], pairwise: false, dryRun: false, model: DEFAULT_RUBRIC_JUDGE_MODEL };
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--ids') args.ids = (raw[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (raw[i] === '--model') args.model = raw[++i] ?? args.model;
    else if (raw[i] === '--pairwise') args.pairwise = true;
    else if (raw[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** OpenRouter without the usage ledger: this script must write nothing. */
const unmeteredOpenRouterLlm: RubricJudgeLlm = {
  async complete(request) {
    const { agentModeService } = await import('../services/agentModeService');
    const { resolveOpenRouterUpstreamModelId } = await import('../utils/openRouterGatewayContract');
    const client = await agentModeService.getOpenRouterClient();
    const res = await client.chat.completions.create(
      {
        model: resolveOpenRouterUpstreamModelId(request.model),
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.content },
        ],
        max_tokens: request.maxTokens,
      },
      { timeout: request.timeoutMs },
    );
    return readChatCompletion(res);
  },
};

async function briefFor(candidate: HumanEvalCandidate): Promise<CreativeBrief> {
  const { resolveBrandGuidelinesForUser } = await import('../services/agentMode/brandLogo');
  const brandData = candidate.userId ? (await resolveBrandGuidelinesForUser(candidate.userId))?.brandData : undefined;
  const brand = brandProfileFromBrandData(brandData);
  const placement = placementFromGates(candidate.creativeGates);
  return {
    ...(candidate.originalRequest ? { generationRequest: candidate.originalRequest } : {}),
    ...(placement ? { placement } : {}),
    ...(brand ? { brand } : {}),
  };
}

function imageSource(url: string | undefined): string {
  if (!url) return 'none';
  if (url.startsWith('data:')) return 'data-uri';
  return /\.s3[.-]/.test(url) ? 's3' : 'https';
}

/** Rough per-creative cost: prompt text at ~4 chars/token, image at w*h/750 after the 1568px cap. */
function estimateCostUsd(model: string, candidate: HumanEvalCandidate, brief: CreativeBrief): number | null {
  const price = getModelPrice(model);
  if (!price) return null;
  const w = candidate.creativeGates?.width ?? 1080;
  const h = candidate.creativeGates?.height ?? 1350;
  const scale = Math.min(1, 1568 / Math.max(w, h));
  const imageTokens = Math.ceil((w * scale * h * scale) / 750);
  const textTokens = Math.ceil((RUBRIC_SYSTEM_PROMPT.length + JSON.stringify(brief).length + 600) / 4);
  const outputTokens = 700;
  return ((imageTokens + textTokens) * price.inPerM + outputTokens * price.outPerM) / 1_000_000;
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));
  if (args.ids.length === 0) {
    console.error('Usage: scoreCreativeRubric.ts --ids <candidateId,...> [--pairwise] [--model <id>] [--dry-run]');
    exit(1);
  }
  const { humanEvalService } = await import('../services/humanEvalService');

  const perCriterion = Object.fromEntries(RUBRIC_CRITERIA.map((id) => [id, { pass: 0, fail: 0 }]));
  const statusCounts: Record<string, number> = {};
  const pairwiseChoices: PairwiseChoice[] = [];
  let pool: HumanEvalCandidate[] | null = null;
  let tokensIn = 0;
  let tokensOut = 0;

  for (const [index, id] of args.ids.entries()) {
    const label = `#${index + 1}`;
    const candidate = await humanEvalService.getCandidate(id);
    if (!candidate || candidate.reviewType !== 'creative_image' || !candidate.artifactUrl) {
      console.log(`${label}: not a creative_image candidate with an image — skipped`);
      statusCounts.not_found = (statusCounts.not_found ?? 0) + 1;
      continue;
    }
    const brief = await briefFor(candidate);

    if (args.dryRun) {
      const cost = estimateCostUsd(args.model, candidate, brief);
      console.log(
        `${label}: category=${candidate.category ?? 'uncategorized'} image=${imageSource(candidate.artifactUrl)} ` +
          `gates=${candidate.creativeGates ? (candidate.creativeGates.passed ? 'pass' : 'fail') : 'absent'} ` +
          `placement=${brief.placement ? 'yes' : 'no'} brand=${brief.brand ? 'yes' : 'no'} ` +
          `request=${brief.generationRequest ? 'yes' : 'no'} rubric=${candidate.creativeRubric?.status ?? 'absent'} ` +
          `estCost=$${cost === null ? '?' : cost.toFixed(4)}`,
      );
      continue;
    }

    const result = await judgeCreative(
      { image: { url: candidate.artifactUrl }, ...(candidate.creativeGates ? { gates: candidate.creativeGates } : {}) },
      brief,
      { model: args.model, llm: unmeteredOpenRouterLlm },
    );
    statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    tokensIn += result.usage?.inputTokens ?? 0;
    tokensOut += result.usage?.outputTokens ?? 0;
    if (result.status === 'ok') {
      for (const c of RUBRIC_CRITERIA) perCriterion[c][result.criteria[c].verdict] += 1;
      const failed = RUBRIC_CRITERIA.filter((c) => result.criteria[c].verdict === 'fail');
      console.log(`${label}: ${result.passedCount}/7 pass${failed.length ? ` — fail: ${failed.join(', ')}` : ''}`);
    } else if (result.status === 'error') {
      console.log(`${label}: ERROR ${result.error.kind}`);
    }

    if (args.pairwise) {
      pool ??= await humanEvalService.listCandidates({ reviewType: 'creative_image', limit: 200 });
      const prior = selectPriorBest(candidate, pool);
      if (!prior?.artifactUrl) {
        console.log(`${label}: no prior creative for this account and placement`);
        continue;
      }
      const pair = await judgeCreativePair(
        { image: { url: candidate.artifactUrl }, ...(candidate.creativeGates ? { gates: candidate.creativeGates } : {}) },
        { image: { url: prior.artifactUrl }, ...(prior.creativeGates ? { gates: prior.creativeGates } : {}) },
        brief,
        { model: args.model, llm: unmeteredOpenRouterLlm },
      );
      tokensIn += pair.usage?.inputTokens ?? 0;
      tokensOut += pair.usage?.outputTokens ?? 0;
      if (pair.status === 'ok') {
        pairwiseChoices.push(pair.preference);
        console.log(`${label}: pairwise vs prior → ${pair.preference === 'A' ? 'new' : pair.preference === 'B' ? 'prior' : 'tie'} (shown ${pair.presentedOrder})`);
      } else {
        console.log(`${label}: pairwise ERROR ${pair.error.kind}`);
      }
    }
  }

  if (args.dryRun) return;
  console.log('\nStatus counts:', statusCounts);
  console.table(perCriterion);
  const price = getModelPrice(args.model);
  const cost = price ? (tokensIn * price.inPerM + tokensOut * price.outPerM) / 1_000_000 : null;
  console.log(`Tokens: ${tokensIn} in / ${tokensOut} out${cost === null ? '' : ` ≈ $${cost.toFixed(4)} at list price`}`);
  if (pairwiseChoices.length > 0) console.log('Pairwise (A = newer creative):', pairwiseWinRate(pairwiseChoices));
}

main()
  .then(() => exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    exit(1);
  });
