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
 *     [--model anthropic.claude-sonnet-5] [--all-agent-cases] [--out verdicts.json]
 */
import AWS from 'aws-sdk';
import { writeFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { goldenSetStoreFromEnv, GOLDEN_CASES_TABLE_ENV } from '../loops/eval/goldenSetStore';
import { loadTraceForGrading } from '../loops/eval/runValidation';
import type { ReadOnlyDocReader } from '../loops/eval/agentGraderLoader';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { readChatCompletion, type RubricJudgeLlm } from '../services/creativeRubricJudge';
import { DEFAULT_TASK_SUCCESS_JUDGE_MODEL, judgeTaskSuccess, TASK_SUCCESS_JUDGE_VERSION } from '../services/taskSuccessJudge';

export interface TrialArgs {
  split: 'dev' | 'test';
  maxUsd: number;
  model: string;
  allAgentCases: boolean;
  out?: string;
}

const USAGE =
  'Usage: runTaskSuccessJudgeTrial.ts --split dev|test [--max-usd 3] [--model <id>] [--all-agent-cases] [--out <file>]';

export function parseTrialArgs(raw: string[]): TrialArgs {
  const args: TrialArgs = { split: 'test', maxUsd: 3, model: DEFAULT_TASK_SUCCESS_JUDGE_MODEL, allAgentCases: false };
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i];
    const value = raw[i + 1];
    if (flag === '--split' && (value === 'dev' || value === 'test')) (args.split = value), i++;
    else if (flag === '--max-usd' && Number(value) > 0) (args.maxUsd = Number(value)), i++;
    else if (flag === '--model' && value) (args.model = value), i++;
    else if (flag === '--out' && value) (args.out = value), i++;
    else if (flag === '--all-agent-cases') args.allAgentCases = true;
    else throw new Error(`${USAGE}\nunknown or invalid argument: ${flag}`);
  }
  return args;
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
      )) as unknown as Parameters<typeof readChatCompletion>[0] & { usage?: Record<string, unknown> };
      const usage = res.usage as { cost?: unknown; cost_details?: { upstream_inference_cost?: unknown } } | undefined;
      const reported = [usage?.cost, usage?.cost_details?.upstream_inference_cost].find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
      // No reported cost means the cap can't work: stop instead of spending blind.
      if (typeof reported !== 'number') throw new Error('OpenRouter reported no cost for a judge call; refusing to continue without a working --max-usd cap');
      cost.usd += reported;
      return readChatCompletion(res);
    },
  };
}

async function main(): Promise<void> {
  const args = parseTrialArgs(argv.slice(2));
  const store = goldenSetStoreFromEnv();
  if (!store.isProvisioned()) throw new Error(`Golden-set store not provisioned: set ${GOLDEN_CASES_TABLE_ENV}.`);
  const doc = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const reader: ReadOnlyDocReader = {
    query: (request) => doc.query(request as AWS.DynamoDB.DocumentClient.QueryInput).promise(),
    scan: (request) => doc.scan(request as AWS.DynamoDB.DocumentClient.ScanInput).promise(),
  };
  const prefix = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const tables = { sessions: `${prefix}AW-ChatSessions`, messages: `${prefix}AW-ChatMessages` };

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
  console.log(`judge ${TASK_SUCCESS_JUDGE_VERSION} model ${args.model} split ${args.split}: ${cases.length} cases, cap $${args.maxUsd}`);
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
      const result = await judgeTaskSuccess(loaded, { llm, model: args.model });
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
