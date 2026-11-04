/**
 * Trial run of the LLM task-success judge (ENG-2591) on the golden set's agent cases.
 *
 * For each agent golden case in --split (work-plan sessions by default) it loads the session as a
 * trace, asks the judge for `task_success`, and prints one line per case: `<caseId> <verdict>`.
 * That is what is compared with labels (blind AI labels for a trial; human labels for the real
 * validation, via runGraderValidation.ts agent-task-success-judge).
 *
 * READ-ONLY. It reads the golden-set store, AW-ChatSessions and AW-ChatMessages and writes nothing
 * to them: the judge is called on OpenRouter directly rather than through `AgentModeService.callLLM`,
 * whose usage metering would write spend rows. It stops before the call that would pass --max-usd.
 * Stdout has case ids, verdicts, the running cost, totals and why a case errored — no transcript
 * text or judge reasons; --out writes the reasons (which can quote the session) to a
 * local file, rewritten after every case so a run that stops early keeps what it judged.
 *
 * Usage (default AWS profile; needs EVAL_GOLDEN_CASES_TABLE and an OpenRouter key):
 *   npx ts-node --transpile-only src/scripts/runTaskSuccessJudgeTrial.ts --split test [--max-usd 3] \
 *     [--model anthropic.claude-sonnet-5] [--all-agent-cases] [--out verdicts.json] [--labeller]
 *
 * --labeller runs the blind cross-family labeller (GPT-5.4 by default) instead of the judge, to give
 * the judge's trial a set of labels from outside both its family and the agent's.
 */
import AWS from 'aws-sdk';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { TABLE_PREFIX } from '../config/constants';
import { goldenSetStoreFromEnv, GOLDEN_CASES_TABLE_ENV } from '../loops/eval/goldenSetStore';
import { loadTraceForGrading } from '../loops/eval/runValidation';
import type { ReadOnlyDocReader } from '../loops/eval/agentGraderLoader';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { readChatCompletion, type RubricJudgeLlm } from '../services/creativeRubricJudge';
import {
  DEFAULT_TASK_SUCCESS_JUDGE_MODEL,
  DEFAULT_TASK_SUCCESS_LABELLER_MODEL,
  judgeTaskSuccess,
  labelTaskSuccess,
  TASK_SUCCESS_JUDGE_VERSION,
  TASK_SUCCESS_LABELLER_PROMPT,
  taskSuccessModelProblem,
} from '../services/taskSuccessJudge';

export interface TrialArgs {
  split: 'dev' | 'test';
  maxUsd: number;
  model: string;
  allAgentCases: boolean;
  labeller: boolean;
  out?: string;
}

const USAGE =
  'Usage: runTaskSuccessJudgeTrial.ts --split dev|test [--max-usd 3] [--model <id>] [--all-agent-cases] [--out <file>] [--labeller]';

export function parseTrialArgs(raw: string[]): TrialArgs {
  const args: TrialArgs = { split: 'test', maxUsd: 3, model: '', allAgentCases: false, labeller: false };
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i];
    const value = raw[i + 1];
    if (flag === '--all-agent-cases') args.allAgentCases = true;
    else if (flag === '--labeller') args.labeller = true;
    else {
      // The remaining flags take a value.
      if (flag === '--split' && (value === 'dev' || value === 'test')) args.split = value;
      else if (flag === '--max-usd' && Number(value) > 0) args.maxUsd = Number(value);
      else if (flag === '--model' && value) args.model = value;
      else if (flag === '--out' && value) args.out = value;
      else throw new Error(`${USAGE}\nunknown or invalid argument: ${flag}`);
      i++;
    }
  }
  if (!args.model) args.model = args.labeller ? DEFAULT_TASK_SUCCESS_LABELLER_MODEL : DEFAULT_TASK_SUCCESS_JUDGE_MODEL;
  return args;
}

/**
 * What one OpenRouter call cost us. On our own provider key (BYOK) `usage.cost` is only OpenRouter's
 * fee and the provider bills the upstream inference cost directly, so both count (the same rule
 * as openRouterByokCostUsd in funding/recordLlmUsage.ts, which books agentModeService calls; that
 * one also falls back to price-book tokens when a fee comes with no upstream bill, this trial helper
 * just reports what the response says). Undefined when the response reports no cost.
 */
export function openRouterCallCostUsd(res: { usage?: unknown; openrouter_metadata?: { is_byok?: unknown } }): number | undefined {
  const usage = res.usage as { cost?: unknown; is_byok?: unknown; cost_details?: { upstream_inference_cost?: unknown } } | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  const gateway = num(usage?.cost);
  const upstream = num(usage?.cost_details?.upstream_inference_cost);
  // OpenRouter flags BYOK in the usage block; the routing-metadata block (opt-in) carries it too.
  const byok = usage?.is_byok === true || res.openrouter_metadata?.is_byok === true || (gateway === 0 && (upstream ?? 0) > 0);
  // On our own key without an upstream cost, what the provider billed is unknown, not zero.
  if (byok) return upstream === undefined ? undefined : (gateway ?? 0) + upstream;
  return gateway;
}

/** The call's cost for the --max-usd cap; throws when none was reported, since the cap can't work blind. A cost of 0 is a cost. */
export function requireReportedCostUsd(res: Parameters<typeof openRouterCallCostUsd>[0]): number {
  const reported = openRouterCallCostUsd(res);
  if (reported === undefined) throw new Error('OpenRouter reported no cost for a judge call; refusing to continue without a working --max-usd cap');
  return reported;
}

/** OpenRouter without the usage ledger; adds each call's reported cost to `cost.usd`. */
async function unmeteredJudgeLlm(cost: { usd: number }): Promise<RubricJudgeLlm> {
  const { agentModeService } = await import('../services/agentModeService');
  const { resolveOpenRouterUpstreamModelId } = await import('../utils/openRouterGatewayContract');
  const client = await agentModeService.getOpenRouterClient();
  return {
    async complete(request) {
      // Non-streaming request: the response is a single completion with usage.
      const res = (await client.chat.completions.create(
        {
          model: resolveOpenRouterUpstreamModelId(request.model),
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n') },
          ],
          ...(LLM_MODEL_REGISTRY[request.model]?.supportsTemperature === false ? {} : { temperature: 0 }),
          max_tokens: request.maxTokens,
          // OpenRouter reports each call's cost only when asked; the cap depends on it.
          usage: { include: true },
        } as Parameters<typeof client.chat.completions.create>[0],
        { timeout: request.timeoutMs },
      )) as unknown as Parameters<typeof readChatCompletion>[0] & { usage?: Record<string, unknown>; openrouter_metadata?: { is_byok?: unknown } };
      cost.usd += requireReportedCostUsd(res);
      return readChatCompletion(res);
    },
  };
}

async function main(): Promise<void> {
  const args = parseTrialArgs(argv.slice(2));
  // Refuse a wrong model before reading any session, not once per case.
  const modelProblem = taskSuccessModelProblem(args.model, args.labeller ? 'labeller' : 'judge');
  if (modelProblem) throw new Error(modelProblem);
  const store = goldenSetStoreFromEnv();
  if (!store.isProvisioned()) throw new Error(`Golden-set store not provisioned: set ${GOLDEN_CASES_TABLE_ENV}.`);
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const reader: ReadOnlyDocReader = {
    query: (request) => doc.query(request as AWS.DynamoDB.DocumentClient.QueryInput).promise(),
    scan: (request) => doc.scan(request as AWS.DynamoDB.DocumentClient.ScanInput).promise(),
  };
  const tables = { sessions: `${TABLE_PREFIX}AW-ChatSessions`, messages: `${TABLE_PREFIX}AW-ChatMessages` };

  const cases = (await store.listCases('agent'))
    .filter((c) => c.split === args.split && c.sourceRef.kind === 'sessionId')
    .filter((c) => args.allAgentCases || c.seedSource === 'work_plan_session')
    .sort((a, b) => a.caseId.localeCompare(b.caseId));

  const cost = { usd: 0 };
  const llm = await unmeteredJudgeLlm(cost);
  const out: Record<string, { verdict?: string; reason: string; status: string }> = {};
  const tally: Record<string, number> = {};
  let judged = 0;
  const save = () => {
    if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
  };
  let outcome = 'aborted';
  const label = args.labeller
    ? `labeller prompt-sha256:${createHash('sha256').update(TASK_SUCCESS_LABELLER_PROMPT).digest('hex').slice(0, 12)}`
    : `judge ${TASK_SUCCESS_JUDGE_VERSION}`;
  const run = args.labeller ? labelTaskSuccess : judgeTaskSuccess;
  console.log(`${label} model ${args.model} split ${args.split}: ${cases.length} cases, cap $${args.maxUsd}`);
  try {
    for (const c of cases) {
      // Stop before a call that would pass the cap: assume the next costs what the average one did.
      const nextEstimate = judged ? cost.usd / judged : 0;
      if (cost.usd + nextEstimate > args.maxUsd) {
        console.log(`stopped at the cost cap after ${judged} cases ($${cost.usd.toFixed(3)})`);
        outcome = 'stopped at cap';
        break;
      }
      const loaded = await loadTraceForGrading(reader, tables, c.sourceRef.id);
      if (!loaded) {
        out[c.caseId] = { status: 'missing', reason: 'session not found' };
        tally.missing = (tally.missing ?? 0) + 1;
        console.log(`${c.caseId} missing`);
        save();
        continue;
      }
      const result = await run(loaded, { llm, model: args.model });
      if (result.status === 'error' && /reported no cost/.test(result.reason)) throw new Error(result.reason);
      judged += 1;
      const key = result.status === 'ok' ? result.verdict : 'error';
      tally[key] = (tally[key] ?? 0) + 1;
      out[c.caseId] = result.status === 'ok'
        ? { status: 'ok', verdict: result.verdict, reason: result.reason }
        : { status: 'error', reason: result.reason };
      save();
      // An invalid verdict quotes the model's text, which can quote the session: print only its kind.
      const why = result.status === 'error' ? ` (${result.reason.replace(/^invalid verdict[\s\S]*/, 'invalid verdict').slice(0, 200)})` : '';
      console.log(`${c.caseId} ${key} $${cost.usd.toFixed(3)}${why}`);
    }
    if (outcome === 'aborted') outcome = 'done';
  } finally {
    try {
      save();
    } catch (err) {
      console.error(`could not write ${args.out}: ${err instanceof Error ? err.message : err}`);
    }
    console.log(`${outcome}: ${JSON.stringify(tally)} cost $${cost.usd.toFixed(3)}${args.out ? ` (reasons in ${args.out})` : ''}`);
  }
}

if (require.main === module) {
  // Exit explicitly: the AWS and OpenRouter clients keep sockets open, so the process lingers after done:.
  main().then(
    () => exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    },
  );
}
