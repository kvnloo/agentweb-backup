/**
 * ENG-2649: blind quality-per-dollar A/B of the AgentWeb Model router against the current per-task defaults.
 * The logic is loops/eval/routerAb.ts and routerAbBudget.ts (tested); this file wires it to the agent loop, the
 * judge and the disk.
 *
 *   plan          free, offline: the cells, which judges may judge each, and the upper-bound spend.
 *   budget        free: create the shared budget file (global caps for every run), or show what it has spent.
 *   generate      PAID: runs every synthetic task once per arm, in-process on the Dev tables, tools in mock mode, with
 *                 the product's verified-chat retries for a required tool.
 *   judge         PAID: blind pairwise judging (both presentation orders) on OpenRouter.
 *   report        free: per-cell summary and the pre-registered verdict; --human folds in blind human ratings.
 *   export-human  free: a blinded side-by-side sheet, its sealed key and a ratings template for human raters.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts plan --table <table.json> --incumbents <incumbents.json> [--tier Free]
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts budget --budget-file <f> --generation-cap 150 --judge-cap 50
 *   NODE_ENV=development AWS_S3_BUCKET=<non-production bucket> npx ts-node --transpile-only src/scripts/routerAbEval.ts \
 *     generate --table <t> --incumbents <i> --user-id <Dev eval user> --out-dir <dir> --budget-file <f> \
 *     [--tier Free] [--task-type report] [--limit 2] [--retry-errors] [--allow-env-key]
 *   NODE_ENV=development AWS_S3_BUCKET=<...> npx ts-node --transpile-only src/scripts/routerAbEval.ts judge --out-dir <dir> \
 *     --budget-file <f> [--judges openrouter/openai/gpt-6-sol,anthropic.claude-sonnet-5] [--allow-env-key]
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts report --out-dir <dir> [--judges <same as judge>] \
 *     [--human ratings.csv] [--reprice gemini-3.8-flash=1.5/7.5]
 *   (the first judge allowed for a cell decides it; the others are an agreement check)
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts export-human --out-dir <dir> [--per-cell 10]
 *
 * Exit codes: 0 done, 1 error or refused, 3 stopped at the budget cap, 4 stopped because a call reported no cost.
 *
 * Safety: the paid commands refuse anything but NODE_ENV=development (Dev-* tables, the dev OpenRouter secret),
 * refuse an exported OPENROUTER_API_KEY unless --allow-env-key, refuse an unset or production AWS_S3_BUCKET, refuse an
 * admin, a shared QA account or a user off the RFC 2606/6761 reserved domains, refuse a task set not marked synthetic,
 * and reserve every LLM call against the shared budget file before sending it (routerAbBudget.ts). Every command
 * resumes: finished runs and judgements are skipped; an aborted run is redone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { argv, exit } from 'node:process';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEFAULT_DECISION_RULE,
  DEFAULT_HUMAN_AGREEMENT,
  DEFAULT_PRIMARY_JUDGE,
  DEFAULT_SECONDARY_JUDGE,
  GENERATION_PROFILE,
  ROUTER_AB_VERSION,
  SESSION_SHAPE,
  VERIFIED_CHAT_MAX_ATTEMPTS,
  callUpperBoundUsd,
  combineOrders,
  decideCell,
  estimateCost,
  flooredJudgement,
  humanAgreement,
  humanFirstArm,
  isReservedDomain,
  judgeProblem,
  judgeSystemPrompt,
  judgeUserContent,
  missingRequiredTools,
  modelForArm,
  pairId,
  parseJudgeVerdict,
  resolveCells,
  runFailure,
  sampleAcrossTemplates,
  summarizeCell,
  taskSetFingerprint,
  taskSetProblems,
  transcriptOf,
  usageCostUsd,
  verifiedChatRetryMessage,
  type AbTask,
  type Arm,
  type Cell,
  type HumanRating,
  type PairData,
  type PairJudgement,
  type RunRecord,
  type TurnUsage,
} from '../loops/eval/routerAb';
import {
  BudgetExceededError,
  BudgetLedger,
  CostMeter,
  readJsonlRepairing,
  reportedCostUsd,
} from '../loops/eval/routerAbBudget';
import { ROUTER_AB_TASK_SET_VERSION, buildSyntheticTaskSet } from '../loops/eval/routerAbTasks';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { registryRouterCatalog } from '../services/agentMode/agentWebModelRouterInstance';
import { resolveLegacyModelAlias } from '../services/agentMode/modelAccess';
import { isContextLimitError, isTransientLLMError } from '../utils/agentModeErrors';
import { getModelPrice, type ModelPrice } from '../utils/llmPricing';

export const EXIT_STOPPED_AT_CAP = 3;
export const EXIT_COST_UNREPORTED = 4;

/** Output allowance assumed for a call that sets none, for its reservation only. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/** Reservation for an OpenRouter call made outside callLLM (none is expected in mock mode). */
const DIRECT_CALL_RESERVE_USD = 1;
const JUDGE_MAX_TOKENS = 8_000;

type Flags = Record<string, string | true>;

export function parseFlags(raw: readonly string[]): { command: string; flags: Flags } {
  const [command, ...rest] = raw;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${flag}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[flag.slice(2)] = next;
      i++;
    } else {
      flags[flag.slice(2)] = true;
    }
  }
  return { command: command ?? '', flags };
}

function str(flags: Flags, name: string, required = true): string | undefined {
  const v = flags[name];
  if (typeof v === 'string' && v) return v;
  if (required) throw new Error(`--${name} is required`);
  return undefined;
}

function positiveUsd(flags: Flags, name: string): number {
  const v = Number(str(flags, name));
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} must be a positive number of USD`);
  return v;
}

// ── refusals ─────────────────────────────────────────────────────────────────

/** The paid commands only ever run against the Dev tables and the dev OpenRouter secret. */
export function requireDevelopment(nodeEnv: string | undefined): void {
  if (nodeEnv !== 'development') {
    throw new Error(`NODE_ENV is ${nodeEnv === undefined ? 'not set' : `"${nodeEnv}"`}: paid commands run only with NODE_ENV=development (Dev-* tables, dev OpenRouter key). Never production.`);
  }
}

/** The bucket every S3 write falls back to when AWS_S3_BUCKET is unset (db.ts, blog.ts, ...): production. */
const PRODUCTION_S3_BUCKET = 'agentweb-user-files';

/** Mock mode should write nothing to S3; if anything does, it must not land in the production bucket. */
export function s3BucketProblem(bucket: string | undefined): string | undefined {
  if (!bucket?.trim()) return `AWS_S3_BUCKET is not set, so any S3 write would fall back to the production bucket ${PRODUCTION_S3_BUCKET}: set it to a non-production bucket`;
  if (bucket.trim() === PRODUCTION_S3_BUCKET || /prod/i.test(bucket)) return `AWS_S3_BUCKET=${bucket} looks like a production bucket: use a non-production bucket`;
  return undefined;
}

/**
 * With NODE_ENV=development, agentModeService reads the dev OpenRouter secret, unless OPENROUTER_API_KEY is exported,
 * which silently wins. That is refused unless the caller says so explicitly.
 */
export function openRouterKeySource(env: Record<string, string | undefined>, allowEnvKey: boolean): { source: string } | { problem: string } {
  if (env.OPENROUTER_API_KEY?.trim()) {
    return allowEnvKey
      ? { source: 'OPENROUTER_API_KEY from the environment (--allow-env-key)' }
      : { problem: 'OPENROUTER_API_KEY is exported and would replace the dev OpenRouter secret: unset it, or pass --allow-env-key if that key is intended' };
  }
  return { source: 'Secrets Manager dev/AgentWeb/OpenRouter' };
}

/** Shared QA accounts other people test with (CLAUDE.md "Test Accounts"): never spend or write sessions as them. */
const SHARED_QA_ACCOUNTS = new Set(['test@example.com', 'test1@example.com']);

export function evalUserProblem(user: { email?: unknown; isAdmin?: unknown } | null | undefined): string | undefined {
  if (!user) return 'the --user-id does not exist in the Dev users table';
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  const domain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
  if (!domain || !isReservedDomain(domain)) {
    return 'the --user-id must be an eval account on an RFC 2606/6761 reserved domain (.test/.example/.invalid/.localhost, example.com/net/org), never a real user';
  }
  if (SHARED_QA_ACCOUNTS.has(email)) return `${email} is a shared QA account: use an account only this experiment writes to`;
  if (user.isAdmin === true) return 'the --user-id is an admin: admins get admin tools, which customers do not, so the runs would not be representative';
  return undefined;
}

/**
 * The skills that carry each required tool must be allowed for the eval user's tier, or every run of that cell would
 * fail on both arms for a configuration reason.
 */
export function skillEntitlementProblems(
  requiredTools: readonly string[],
  publishedSkills: ReadonlyArray<{ skillId: string; toolNames?: string[] }>,
  allowedSkillIds: readonly string[] | null,
): string[] {
  if (allowedSkillIds === null) return ['the eval user\'s tier could not be resolved (getAllowedSkills returned null)'];
  if (allowedSkillIds.includes('*')) return [];
  const problems: string[] = [];
  for (const tool of new Set(requiredTools)) {
    const carriers = publishedSkills.filter((s) => s.toolNames?.includes(tool));
    if (carriers.length > 0 && !carriers.some((s) => allowedSkillIds.includes(s.skillId))) {
      problems.push(`${tool}: none of the skills carrying it (${carriers.map((s) => s.skillId).join(', ')}) is allowed for the eval user's tier`);
    }
  }
  return problems;
}

/**
 * A bare script process has not run the server's boot, so the agent-mode tool registry is empty: `install_skills` is then
 * "Unknown tool" in mock mode and the model never reaches the flow's required tool. Refuse before any paid call.
 */
export function toolRegistryProblems(
  service: { toolRegistry?: { getTool(name: string): unknown } },
  names: readonly string[] = ['install_skills'],
): string[] {
  const registry = service.toolRegistry;
  if (!registry || typeof registry.getTool !== 'function') return ['the agent-mode tool registry is not readable'];
  return names.filter((name) => !registry.getTool(name)).map((name) => `${name} is not registered after initialize()`);
}

// ── inputs ───────────────────────────────────────────────────────────────────

const providerOf = (model: string): string | undefined => LLM_MODEL_REGISTRY[model]?.provider;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadTasks(flags: Flags): AbTask[] {
  const file = str(flags, 'tasks', false);
  const tasks = file ? (readJson(file) as AbTask[]) : buildSyntheticTaskSet();
  const problems = taskSetProblems(tasks);
  if (problems.length) throw new Error(`task set unusable:\n- ${problems.slice(0, 20).join('\n- ')}`);
  return tasks;
}

function loadCells(flags: Flags): { cells: Cell[]; tier: string | null; tableVersion: string } {
  const table = readJson(str(flags, 'table')!);
  const incumbents = readJson(str(flags, 'incumbents')!) as Record<string, string>;
  const tier = str(flags, 'tier', false) ?? null;
  const { cells, errors } = resolveCells(table, tier, incumbents, registryRouterCatalog);
  if (errors.length) throw new Error(`cannot resolve the arms:\n- ${errors.join('\n- ')}`);
  return { cells, tier, tableVersion: String((table as { version?: unknown }).version ?? '') };
}

function judgeList(flags: Flags): string[] {
  const raw = str(flags, 'judges', false);
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [DEFAULT_PRIMARY_JUDGE, DEFAULT_SECONDARY_JUDGE];
}

/** Judges allowed for a cell: registered, and from a provider that wrote neither arm. */
function judgesFor(cell: Cell, judges: readonly string[]): { allowed: string[]; refused: string[] } {
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const judge of judges) {
    const problem = judgeProblem(judge, [cell.router.model, cell.incumbent.model], providerOf);
    if (problem) refused.push(problem);
    else allowed.push(judge);
  }
  return { allowed, refused };
}

const usd = (v: number) => `$${v.toFixed(2)}`;

// ── plan ─────────────────────────────────────────────────────────────────────

function plan(flags: Flags): number {
  const tasks = loadTasks(flags);
  const { cells, tier } = loadCells(flags);
  const judges = judgeList(flags);
  const profileFile = str(flags, 'profile', false);
  const profile = profileFile ? (readJson(profileFile) as Partial<typeof GENERATION_PROFILE>) : {};
  console.log(`Router A/B ${ROUTER_AB_VERSION}, tasks ${ROUTER_AB_TASK_SET_VERSION} (${taskSetFingerprint(tasks)}), tier ${tier ?? '(no tier override)'}\n`);
  const judgedCells: Cell[] = [];
  for (const cell of cells) {
    const n = tasks.filter((t) => t.taskType === cell.taskType).length;
    if (cell.identical) {
      console.log(`${cell.taskType.padEnd(9)} router ${cell.router.model} = incumbent: identical, not run`);
      continue;
    }
    const { allowed, refused } = judgesFor(cell, judges);
    const unsupported = SESSION_SHAPE[cell.taskType] === null ? ' — NOT RUNNABLE in-process (scheduled runs need runScheduledChat)' : '';
    console.log(`${cell.taskType.padEnd(9)} router ${cell.router.model} (${cell.router.reason}) vs incumbent ${cell.incumbent.model}: ${n} tasks${unsupported}`);
    console.log(`          judges: ${allowed.join(', ') || 'NONE'}${refused.length ? `; refused: ${refused.join('; ')}` : ''}`);
    if (n === 0) console.log('          NO TASKS for this task type in the set');
    judgedCells.push(cell);
  }
  const estimate = estimateCost(tasks, judgedCells, [], profile);
  let judgeUsd = 0;
  for (const cell of judgedCells) judgeUsd += estimateCost(tasks, [cell], judgesFor(cell, judges).allowed, profile).judgeUsd;
  console.log('\nUpper-bound spend (no prompt caching, one attempt per run; replace the profile with pilot means via --profile):');
  for (const c of estimate.perCell) console.log(`  ${c.taskType.padEnd(9)} generation ${usd(c.generationUsd)} (${c.tasks} tasks x 2 arms)`);
  console.log(`  generation total ${usd(estimate.generationUsd)}, judging ${usd(judgeUsd)}, total ${usd(estimate.generationUsd + judgeUsd)}`);
  return 0;
}

// ── budget ───────────────────────────────────────────────────────────────────

function budget(flags: Flags): number {
  const file = str(flags, 'budget-file')!;
  if (flags['generation-cap'] !== undefined || flags['judge-cap'] !== undefined) {
    BudgetLedger.init(file, { generationUsd: positiveUsd(flags, 'generation-cap'), judgeUsd: positiveUsd(flags, 'judge-cap') });
    console.log(`Created ${file}`);
  }
  const ledger = BudgetLedger.open(file, { lock: false });
  for (const kind of ['generation', 'judge'] as const) {
    console.log(`${kind.padEnd(10)} ${usd(ledger.spent(kind))} of ${usd(ledger.cap(kind))} spent, ${usd(ledger.remaining(kind))} left`);
  }
  return 0;
}

// ── shared state on disk ─────────────────────────────────────────────────────

interface Manifest {
  version: string;
  taskSetVersion: string;
  taskSetFingerprint: string;
  tier: string | null;
  tableVersion: string;
  cells: Cell[];
  tasks: AbTask[];
  createdAt: string;
}

function files(outDir: string) {
  return {
    manifest: path.join(outDir, 'manifest.json'),
    runs: path.join(outDir, 'runs.jsonl'),
    judgements: path.join(outDir, 'judgements.jsonl'),
    judgeErrors: path.join(outDir, 'judge-errors.jsonl'),
    report: path.join(outDir, 'report.md'),
    sheet: path.join(outDir, 'human-sheet.html'),
    key: path.join(outDir, 'human-key.json'),
    ratings: path.join(outDir, 'human-ratings.csv'),
  };
}

function loadManifest(outDir: string): Manifest {
  const f = files(outDir).manifest;
  if (!existsSync(f)) throw new Error(`${f} not found: run generate first`);
  return readJson(f) as Manifest;
}

/** The latest record per key wins, so a redone run or judgement replaces the earlier one. */
function latestBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

const runKey = (r: { taskId: string; arm: Arm }) => `${r.taskId}\u0000${r.arm}`;
const judgeKey = (j: { taskId: string; judge: string }) => `${j.taskId}\u0000${j.judge}`;

/** A stored judgement names the two runs it judged (stale once either is redone) and what its calls cost. */
type StoredJudgement = PairJudgement & { runs?: { router: string; incumbent: string }; costUsd?: number };

function currentJudgement(j: StoredJudgement | undefined, pair: { router: RunRecord; incumbent: RunRecord }): PairJudgement | undefined {
  return j && j.runs?.router === pair.router.startedAt && j.runs?.incumbent === pair.incumbent.startedAt ? j : undefined;
}

/** Pairs with both runs measured: an aborted run is not a measurement (it is redone on the next generate). */
function pairsFor(manifest: Manifest, runs: Map<string, RunRecord>, cell: Cell): Array<{ task: AbTask; router: RunRecord; incumbent: RunRecord }> {
  const out: Array<{ task: AbTask; router: RunRecord; incumbent: RunRecord }> = [];
  for (const task of manifest.tasks.filter((t) => t.taskType === cell.taskType)) {
    const router = runs.get(runKey({ taskId: task.taskId, arm: 'router' }));
    const incumbent = runs.get(runKey({ taskId: task.taskId, arm: 'incumbent' }));
    if (router && incumbent && router.status !== 'aborted' && incumbent.status !== 'aborted') out.push({ task, router, incumbent });
  }
  return out;
}

// ── paid-command setup ───────────────────────────────────────────────────────

function preflightPaid(flags: Flags): void {
  requireDevelopment(process.env.NODE_ENV);
  const bucketProblem = s3BucketProblem(process.env.AWS_S3_BUCKET);
  if (bucketProblem) throw new Error(bucketProblem);
  const key = openRouterKeySource(process.env, flags['allow-env-key'] === true);
  if ('problem' in key) throw new Error(key.problem);
  console.log(`OpenRouter key: ${key.source}; S3 bucket: ${process.env.AWS_S3_BUCKET}`);
}

/** `openRouterCallCostUsd` lives with the task-success trial (BYOK-aware); loaded lazily, it pulls in aws-sdk. */
async function loadCostOf(): Promise<(res: any) => number | undefined> {
  const { openRouterCallCostUsd } = await import('./runTaskSuccessJudgeTrial');
  return (res) => openRouterCallCostUsd(res ?? {});
}

/**
 * Routes every LLM call of this process through the meter: callLLM (the agent loop, suggested replies, every side
 * call) and, as a backstop, any request on the OpenRouter client that did not come through callLLM.
 */
function meterAgentModeService(agentModeService: any, client: any, meter: CostMeter): void {
  const viaCallLLM = new AsyncLocalStorage<true>();
  const originalCallLLM = agentModeService.callLLM.bind(agentModeService);
  agentModeService.callLLM = (model: string, messages: any[], options?: any) => {
    const canonical = resolveLegacyModelAlias(model);
    const inputChars = JSON.stringify(messages ?? []).length + JSON.stringify(options?.tools ?? []).length;
    const upperBound = callUpperBoundUsd(canonical, inputChars, options?.max_completion_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
    return meter.meter(canonical, upperBound, () => viaCallLLM.run(true, () => originalCallLLM(model, messages, options)), options?.usageContext?.feature);
  };
  const completions = client.chat.completions;
  const originalCreate = completions.create.bind(completions);
  completions.create = (params: any, requestOptions?: any) => {
    if (viaCallLLM.getStore()) return originalCreate(params, requestOptions);
    console.warn(`routerAbEval: an OpenRouter call (${params?.model}) bypassed callLLM; metered at a $${DIRECT_CALL_RESERVE_USD} reservation`);
    return meter.meter(`direct:${params?.model}`, DIRECT_CALL_RESERVE_USD, () => originalCreate(params, requestOptions), 'direct');
  };
}

function stopCode(meter: CostMeter): number {
  return meter.fatal instanceof BudgetExceededError ? EXIT_STOPPED_AT_CAP : EXIT_COST_UNREPORTED;
}

// ── generate ─────────────────────────────────────────────────────────────────

/** Reads the concrete model, usage and tool calls off the turn's assistant messages. */
export function harvestResponse(responseMessages: readonly any[]): { ranModels: string[]; usage: TurnUsage[]; toolCalls: RunRecord['toolCalls'] } {
  const ranModels = new Set<string>();
  const usage: TurnUsage[] = [];
  const toolCalls: RunRecord['toolCalls'] = [];
  for (const m of responseMessages ?? []) {
    if (m?.role !== 'assistant') continue;
    if (typeof m.llm === 'string') ranModels.add(m.llm);
    if (m.usage) {
      usage.push({
        promptTokens: Number(m.usage.prompt_tokens) || 0,
        completionTokens: Number(m.usage.completion_tokens) || 0,
        cacheReadTokens: Number(m.usage.cache_read_input_tokens) || 0,
        cacheWriteTokens: Number(m.usage.cache_creation_input_tokens) || 0,
      });
    }
    for (const tc of m.tool_calls ?? []) {
      const name = tc?.function?.name;
      if (typeof name === 'string') toolCalls.push({ name, args: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}) });
    }
  }
  return { ranModels: [...ranModels], usage, toolCalls };
}

type RunOutcome = Omit<RunRecord, 'calls' | 'costUsd'>;

export interface VerifiedRunDeps {
  generate(message: string, history: any[]): Promise<{ content?: string; responseMessages?: any[] }>;
  /** True once the meter stopped spending: the run is then aborted, never retried. */
  stopped(): boolean;
}

/**
 * One task the way the product's /verified-generate runs it (runVerifiedChatInner): the prompt, then, while a
 * required function is still missing, "Please try again. Make sure to <tool> (1 more time needed)." up to 5 turns
 * in the same conversation; a transient LLM error or a turn with no assistant output is retried within the same
 * budget; anything else ends the run as an error. A task with no required tool (the Emma sidebar) is one turn.
 * Not reproduced: the backoff sleep between attempts (latency only), keyword requirements (none here), and the
 * work-plan reminder (mock mode creates no work plan).
 */
export async function runVerified(task: AbTask, model: string, deps: VerifiedRunDeps, now = () => Date.now()): Promise<Pick<RunOutcome, 'status' | 'error' | 'attempts' | 'ranModels' | 'finalText' | 'toolCalls' | 'usage' | 'latencyMs'>> {
  const t0 = now();
  const maxAttempts = task.requiredTools.length > 0 ? VERIFIED_CHAT_MAX_ATTEMPTS : 1;
  const history: any[] = [];
  const ranModels = new Set<string>();
  const usage: TurnUsage[] = [];
  const toolCalls: RunRecord['toolCalls'] = [];
  let finalText = '';
  let attempt = 0;
  try {
    while (attempt < maxAttempts) {
      attempt++;
      const message = attempt === 1 ? task.prompt : verifiedChatRetryMessage(missingRequiredTools(task.requiredTools, toolCalls));
      let res: { content?: string; responseMessages?: any[] };
      try {
        res = await deps.generate(message, history);
      } catch (error) {
        if (!deps.stopped() && attempt < maxAttempts && isTransientLLMError(error) && !isContextLimitError(error)) continue;
        throw error;
      }
      const harvested = harvestResponse(res.responseMessages ?? []);
      harvested.ranModels.forEach((m) => ranModels.add(m));
      usage.push(...harvested.usage);
      toolCalls.push(...harvested.toolCalls);
      if (typeof res.content === 'string' && res.content.trim()) finalText += (finalText ? '\n\n' : '') + res.content;
      history.push({ role: 'user', content: message }, ...(res.responseMessages ?? []));
      const hasOutput = Boolean(res.content?.trim()) || harvested.toolCalls.length > 0
        || (res.responseMessages ?? []).some((m: any) => m?.role === 'assistant');
      if (!hasOutput) continue;
      if (missingRequiredTools(task.requiredTools, toolCalls).length === 0) break;
    }
    return { status: 'ok', attempts: attempt, ranModels: [...ranModels], finalText, toolCalls, usage, latencyMs: now() - t0 };
  } catch (error) {
    return {
      status: 'error',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      attempts: attempt,
      ranModels: [...ranModels],
      finalText,
      toolCalls,
      usage,
      latencyMs: now() - t0,
    };
  }
}

async function generate(flags: Flags): Promise<number> {
  preflightPaid(flags);
  const outDir = str(flags, 'out-dir')!;
  const userId = str(flags, 'user-id')!;
  const onlyType = str(flags, 'task-type', false);
  const limit = flags.limit === undefined ? Infinity : Number(flags.limit);
  if (!(limit > 0)) throw new Error('--limit must be a positive number of tasks per cell');
  const retryErrors = flags['retry-errors'] === true;
  const tasks = loadTasks(flags);
  const { cells, tier, tableVersion } = loadCells(flags);

  const { userDb } = await import('../services/db');
  const userProblem = evalUserProblem(await userDb.getUserById(userId));
  if (userProblem) throw new Error(userProblem);
  const { skillService } = await import('../services/skillService');
  const { getAllowedSkills } = await import('../services/subscriptionService');
  const publishedSkills = await skillService.getPublishedSkills();
  const allowedSkillIds = await getAllowedSkills(userId);
  const runCells = cells.filter((c) => !c.identical && SESSION_SHAPE[c.taskType] && (!onlyType || c.taskType === onlyType));
  const requiredTools = tasks.filter((t) => runCells.some((c) => c.taskType === t.taskType)).flatMap((t) => t.requiredTools);
  const entitlement = skillEntitlementProblems(requiredTools, publishedSkills, allowedSkillIds);
  if (entitlement.length) throw new Error(`the eval user cannot run these tasks:\n- ${entitlement.join('\n- ')}`);

  const f = files(outDir);
  mkdirSync(outDir, { recursive: true });
  const manifest: Manifest = {
    version: ROUTER_AB_VERSION,
    taskSetVersion: ROUTER_AB_TASK_SET_VERSION,
    taskSetFingerprint: taskSetFingerprint(tasks),
    tier,
    tableVersion,
    cells,
    tasks,
    createdAt: new Date().toISOString(),
  };
  if (existsSync(f.manifest)) {
    const prior = loadManifest(outDir);
    const same = prior.taskSetFingerprint === manifest.taskSetFingerprint && prior.tier === tier
      && JSON.stringify(prior.cells) === JSON.stringify(cells);
    if (!same) throw new Error(`${outDir} holds a run with a different task set, tier or arms; use a new --out-dir`);
  } else {
    writeFileSync(f.manifest, JSON.stringify(manifest, null, 1));
  }

  const ledger = BudgetLedger.open(str(flags, 'budget-file')!);
  try {
    const { chatbotDb } = await import('../services/chatbotService');
    const { agentModeService } = await import('../services/agentModeService');
    // The server runs this at boot; without it the tool registry is empty (ENG-2649 pilot: every run hit "Unknown tool: install_skills").
    await agentModeService.initialize();
    const registryProblems = toolRegistryProblems(agentModeService as any, ['install_skills', ...new Set(requiredTools)]);
    if (registryProblems.length) throw new Error(`agent mode did not initialize:\n- ${registryProblems.join('\n- ')}`);
    const meter = new CostMeter(ledger, 'generation', outDir, await loadCostOf());
    meterAgentModeService(agentModeService, await agentModeService.getOpenRouterClient(), meter);
    const done = latestBy(readJsonlRepairing<RunRecord>(f.runs), runKey);
    console.log(`generate: ${outDir}; generation budget ${usd(ledger.spent('generation'))} of ${usd(ledger.cap('generation'))} spent`);

    for (const cell of runCells) {
      const shape = SESSION_SHAPE[cell.taskType]!;
      for (const task of sampleAcrossTemplates(tasks.filter((t) => t.taskType === cell.taskType), limit)) {
        for (const arm of ['router', 'incumbent'] as const) {
          const prior = done.get(runKey({ taskId: task.taskId, arm }));
          if (prior?.status === 'ok' || (prior?.status === 'error' && !retryErrors)) continue;
          const model = modelForArm(cell, arm);
          const startedAt = new Date().toISOString();
          const { result, calls } = await meter.scoped(`${outDir}:${task.taskId}/${arm}`, async () => {
            const session = await chatbotDb.createChatSession(
              userId, undefined, shape.portalType as any, 'agent-mode', undefined, undefined, undefined, undefined, shape.sessionType as any, undefined,
              { llmModel: model, llmModelSource: 'system' },
            );
            // As runVerifiedChat does for required functions: install the allowed published skills that carry them.
            const required = new Set(task.requiredTools);
            const skillIds = publishedSkills
              .filter((s) => s.toolNames?.some((t) => required.has(t)))
              .filter((s) => allowedSkillIds?.includes('*') || allowedSkillIds?.includes(s.skillId))
              .map((s) => s.skillId);
            if (skillIds.length) await agentModeService.installSkills(skillIds, userId, session.sessionId);
            // mockMode = true: every tool returns its simulated result, nothing leaves the sandbox (no sends, posts,
            // image or video generation), and both arms see identical tool results.
            return runVerified(task, model, {
              generate: (message, history) => agentModeService.generateMarketingResponse(message, history, userId, model, session.sessionId, true),
              stopped: () => Boolean(meter.fatal),
            });
          });
          const outcome = result ?? { status: 'error' as const, error: 'session setup failed', attempts: 0, ranModels: [], finalText: '', toolCalls: [], usage: [], latencyMs: 0 };
          const record: RunRecord = {
            taskId: task.taskId, taskType: task.taskType, arm, model, startedAt, ...outcome,
            ...(meter.fatal ? { status: 'aborted' as const, error: meter.fatal.message } : {}),
            calls, costUsd: reportedCostUsd(calls),
          };
          appendFileSync(f.runs, `${JSON.stringify(record)}\n`);
          const failure = record.status === 'aborted' ? `ABORTED (${record.error})` : runFailure(record, task);
          console.log(`${task.taskId} ${arm} ${model} ${failure ? `FAILED (${failure.slice(0, 160)})` : 'ok'} attempts=${record.attempts} ${usd(record.costUsd)} ${(record.latencyMs / 1000).toFixed(1)}s budget ${usd(ledger.spent('generation'))}`);
          if (meter.fatal) {
            console.log(`stopped: ${meter.fatal.message}`);
            return stopCode(meter);
          }
        }
      }
    }
    console.log(`generate done: generation budget ${usd(ledger.spent('generation'))} of ${usd(ledger.cap('generation'))}`);
    return 0;
  } finally {
    ledger.close();
  }
}

// ── judge ────────────────────────────────────────────────────────────────────

async function judge(flags: Flags): Promise<number> {
  preflightPaid(flags);
  const outDir = str(flags, 'out-dir')!;
  const f = files(outDir);
  const manifest = loadManifest(outDir);
  const judges = judgeList(flags);
  const runs = latestBy(readJsonlRepairing<RunRecord>(f.runs), runKey);
  const done = latestBy(readJsonlRepairing<StoredJudgement>(f.judgements), judgeKey);
  readJsonlRepairing(f.judgeErrors);

  const ledger = BudgetLedger.open(str(flags, 'budget-file')!);
  try {
    const { agentModeService } = await import('../services/agentModeService');
    const { resolveOpenRouterUpstreamModelId } = await import('../utils/openRouterGatewayContract');
    const { readChatCompletion } = await import('../services/creativeRubricJudge');
    const client = await agentModeService.getOpenRouterClient();
    const meter = new CostMeter(ledger, 'judge', outDir, await loadCostOf());
    const upperBound = (model: string, system: string, user: string) =>
      Math.max(callUpperBoundUsd(model, system.length + user.length, JUDGE_MAX_TOKENS), meter.largestSeen(model));
    // Unmetered by the product's usage ledger on purpose (as runTaskSuccessJudgeTrial): eval spend is no customer's.
    const complete = (model: string, system: string, user: string): Promise<string> =>
      meter.meter(model, upperBound(model, system, user), () => client.chat.completions.create(
        {
          model: resolveOpenRouterUpstreamModelId(model),
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          ...(LLM_MODEL_REGISTRY[model]?.supportsTemperature === false ? {} : { temperature: 0 }),
          max_tokens: JUDGE_MAX_TOKENS,
          usage: { include: true },
        } as any,
        { timeout: 180_000 },
      )).then((res: any) => readChatCompletion(res).text);
    console.log(`judge: ${outDir}; judge budget ${usd(ledger.spent('judge'))} of ${usd(ledger.cap('judge'))} spent`);

    for (const cell of manifest.cells) {
      if (cell.identical) continue;
      const { allowed, refused } = judgesFor(cell, judges);
      for (const r of refused) console.log(`${cell.taskType}: ${r}`);
      for (const judgeModel of allowed) {
        for (const pair of pairsFor(manifest, runs, cell)) {
          if (currentJudgement(done.get(judgeKey({ taskId: pair.task.taskId, judge: judgeModel })), pair)) continue;
          const rFail = Boolean(runFailure(pair.router, pair.task));
          const iFail = Boolean(runFailure(pair.incumbent, pair.task));
          const stamp = { runs: { router: pair.router.startedAt, incumbent: pair.incumbent.startedAt } };
          if (rFail || iFail) {
            const stored: StoredJudgement = { ...flooredJudgement(pair.task, judgeModel, rFail, iFail), ...stamp, costUsd: 0 };
            appendFileSync(f.judgements, `${JSON.stringify(stored)}\n`);
            console.log(`${pair.task.taskId} ${judgeModel} ${stored.preference} (floored)`);
            continue;
          }
          const system = judgeSystemPrompt(cell.taskType);
          const routerFirst = judgeUserContent(pair.task, pair.router, pair.incumbent);
          const incumbentFirst = judgeUserContent(pair.task, pair.incumbent, pair.router);
          const need = upperBound(judgeModel, system, routerFirst) + upperBound(judgeModel, system, incumbentFirst);
          if (ledger.remaining('judge') < need) {
            console.log(`stopped before ${pair.task.taskId}: its two calls (up to ${usd(need)}) would pass the judge cap (${usd(ledger.remaining('judge'))} left)`);
            return EXIT_STOPPED_AT_CAP;
          }
          const { result, error, calls } = await meter.scoped(`${outDir}:${pair.task.taskId}/${judgeModel}`, async () => {
            const a = parseJudgeVerdict(await complete(judgeModel, system, routerFirst));
            const b = parseJudgeVerdict(await complete(judgeModel, system, incumbentFirst));
            return combineOrders(pair.task, judgeModel, a, b);
          });
          const costUsd = reportedCostUsd(calls);
          if (meter.fatal) {
            console.log(`stopped: ${meter.fatal.message}`);
            return stopCode(meter);
          }
          if (error !== undefined || !result) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
            appendFileSync(f.judgeErrors, `${JSON.stringify({ taskId: pair.task.taskId, judge: judgeModel, error: message, costUsd, at: new Date().toISOString() })}\n`);
            console.log(`${pair.task.taskId} ${judgeModel} ERROR ${message}`);
            continue;
          }
          const stored: StoredJudgement = { ...result, ...stamp, costUsd };
          appendFileSync(f.judgements, `${JSON.stringify(stored)}\n`);
          console.log(`${pair.task.taskId} ${judgeModel} ${result.preference} r=${result.routerScore} i=${result.incumbentScore} ${usd(costUsd)} budget ${usd(ledger.spent('judge'))}`);
        }
      }
    }
    console.log(`judge done: judge budget ${usd(ledger.spent('judge'))} of ${usd(ledger.cap('judge'))}`);
    return 0;
  } finally {
    ledger.close();
  }
}

// ── report ───────────────────────────────────────────────────────────────────

/** `model=in/out` (USD per 1M tokens), e.g. gemini-3.8-flash=1.5/7.5 for Google's announced 2027 price. */
export function parseReprice(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw) return {};
  const out: Record<string, ModelPrice> = {};
  for (const part of raw.split(',')) {
    const m = /^([^=]+)=([\d.]+)\/([\d.]+)$/.exec(part.trim());
    if (!m) throw new Error(`--reprice expects model=in/out, got ${part}`);
    const base = getModelPrice(m[1]);
    if (!base) throw new Error(`--reprice: ${m[1]} has no price entry to re-price`);
    const inPerM = Number(m[2]);
    const ratio = inPerM / base.inPerM;
    out[m[1]] = {
      inPerM,
      outPerM: Number(m[3]),
      ...(base.cacheReadPerM !== undefined ? { cacheReadPerM: base.cacheReadPerM * ratio } : {}),
      ...(base.cacheWritePerM !== undefined ? { cacheWritePerM: base.cacheWritePerM * ratio } : {}),
    };
  }
  return out;
}

/**
 * A run's cost at a different price for its arm model: the reported cost, moved by the price-book difference on the
 * same tokens (the side calls and the caching OpenRouter applied are kept as observed).
 */
export function repricedCostUsd(run: RunRecord, price: ModelPrice): number {
  return run.costUsd + usageCostUsd(run.model, run.usage, price) - usageCostUsd(run.model, run.usage);
}

export function parseHumanCsv(text: string): HumanRating[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  const ratings: HumanRating[] = [];
  for (const line of rows.slice(1)) {
    const [pid, rater, better] = line.split(',').map((s) => s.trim());
    if (!pid || !rater || !better) continue;
    if (better !== '1' && better !== '2' && better !== 'tie') throw new Error(`human ratings: "better" must be 1, 2 or tie (row: ${line})`);
    ratings.push({ pairId: pid, rater, better });
  }
  return ratings;
}

function cellSection(title: string, cell: Cell, judgeModel: string, pairs: PairData[]): string[] {
  const s = summarizeCell(cell, judgeModel, pairs);
  const d = decideCell(s, DEFAULT_DECISION_RULE);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const attempts = (arm: Arm) => {
    const xs = pairs.map((p) => p[arm].attempts).filter((x) => Number.isFinite(x));
    return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : 'n/a';
  };
  return [
    `### ${title}: ${d.verdict.toUpperCase()}`,
    `router ${s.routerModel} vs incumbent ${s.incumbentModel}, judge ${judgeModel}, ${s.n} judged pairs (${s.judgeErrors} judge errors)`,
    '',
    '| metric | router | incumbent |',
    '|---|---|---|',
    `| failure rate | ${pct(s.failures.routerRate)} (${s.failures.router}) | ${pct(s.failures.incumbentRate)} (${s.failures.incumbent}) |`,
    `| severe (judge) | ${s.severe.router} | ${s.severe.incumbent} |`,
    `| mean score (1-10) | ${s.meanScore.router.toFixed(2)} | ${s.meanScore.incumbent.toFixed(2)} |`,
    `| mean cost per task (errored runs excluded) | $${s.meanCostUsd.router.toFixed(4)} | $${s.meanCostUsd.incumbent.toFixed(4)} |`,
    `| mean turns (verified-chat attempts) | ${attempts('router')} | ${attempts('incumbent')} |`,
    `| latency p50 / p90 | ${(s.latencyMs.router.p50 / 1000).toFixed(1)}s / ${(s.latencyMs.router.p90 / 1000).toFixed(1)}s | ${(s.latencyMs.incumbent.p50 / 1000).toFixed(1)}s / ${(s.latencyMs.incumbent.p90 / 1000).toFixed(1)}s |`,
    `| quality per $ | ${s.qpd.router.toFixed(1)} | ${s.qpd.incumbent.toFixed(1)} |`,
    '',
    `- score diff (router - incumbent): ${s.scoreDiff.mean.toFixed(2)} [${s.scoreDiff.ci[0].toFixed(2)}, ${s.scoreDiff.ci[1].toFixed(2)}]`,
    `- win rate (ties = half): ${s.winRate.value.toFixed(2)} (W${s.winRate.wins}/L${s.winRate.losses}/T${s.winRate.ties}; non-tie CI [${s.winRate.ci[0].toFixed(2)}, ${s.winRate.ci[1].toFixed(2)}])`,
    `- quality-per-dollar ratio: ${s.qpd.ratio.toFixed(2)} [${s.qpd.ci[0].toFixed(2)}, ${s.qpd.ci[1].toFixed(2)}]`,
    `- failure-rate difference CI: [${pct(s.failures.diffCi[0])}, ${pct(s.failures.diffCi[1])}]; order disagreements: ${s.orderDisagreements}`,
    `- verdict: ${d.reasons.join('; ')}`,
    '',
  ];
}

function report(flags: Flags): number {
  const outDir = str(flags, 'out-dir')!;
  const f = files(outDir);
  const manifest = loadManifest(outDir);
  const runs = latestBy(readJsonlRepairing<RunRecord>(f.runs), runKey);
  const judgements = latestBy(readJsonlRepairing<StoredJudgement>(f.judgements), judgeKey);
  const errors = latestBy(readJsonlRepairing<{ taskId: string; judge: string; error: string }>(f.judgeErrors), judgeKey);
  const reprice = parseReprice(str(flags, 'reprice', false));
  const judges = judgeList(flags);
  const lines = [
    `# Router A/B report (${ROUTER_AB_VERSION})`,
    '',
    `Tasks ${manifest.taskSetVersion} (${manifest.taskSetFingerprint}); tier ${manifest.tier ?? '(none)'}; table ${manifest.tableVersion}; rule ${JSON.stringify(DEFAULT_DECISION_RULE)}`,
    '',
  ];
  const primaryByTask = new Map<string, PairJudgement>();
  for (const cell of manifest.cells) {
    if (cell.identical) {
      lines.push(`### ${cell.taskType}: IDENTICAL (router and incumbent both ${cell.router.model}; not run)`, '');
      continue;
    }
    const { allowed } = judgesFor(cell, judges);
    allowed.forEach((judgeModel, index) => {
      const pairs: PairData[] = pairsFor(manifest, runs, cell).map((p) => {
        const j = currentJudgement(judgements.get(judgeKey({ taskId: p.task.taskId, judge: judgeModel })), p);
        const e = j ? undefined : errors.get(judgeKey({ taskId: p.task.taskId, judge: judgeModel }))?.error;
        if (j && index === 0) primaryByTask.set(p.task.taskId, j);
        return { ...p, ...(j ? { judgement: j } : {}), ...(e ? { judgeError: e } : {}) };
      });
      const role = index === 0 ? 'primary judge (decides)' : 'secondary judge (agreement check)';
      lines.push(...cellSection(`${cell.taskType}, ${role}`, cell, judgeModel, pairs));
      const repriced = Object.keys(reprice).some((m) => m === cell.router.model || m === cell.incumbent.model);
      if (index === 0 && repriced) {
        const reprice1 = (r: RunRecord): RunRecord => (reprice[r.model] ? { ...r, costUsd: repricedCostUsd(r, reprice[r.model]) } : r);
        const again = pairs.map((p) => ({ ...p, router: reprice1(p.router), incumbent: reprice1(p.incumbent) }));
        lines.push(...cellSection(`${cell.taskType}, sensitivity (re-priced: ${Object.keys(reprice).join(', ')})`, cell, judgeModel, again));
      }
    });
  }
  const humanFile = str(flags, 'human', false);
  if (humanFile) {
    const key = readJson(f.key) as Record<string, { taskId: string; first: Arm }>;
    const agreement = humanAgreement(parseHumanCsv(readFileSync(humanFile, 'utf8')), key, [...primaryByTask.values()]);
    const ok = agreement.rate >= DEFAULT_HUMAN_AGREEMENT;
    lines.push(
      `### Human validation: ${ok ? 'JUDGE TRUSTED' : 'JUDGE NOT TRUSTED: human ratings decide'}`,
      `${agreement.agreed}/${agreement.compared} non-tie pairs agree with the primary judge (${(agreement.rate * 100).toFixed(0)}%, threshold ${DEFAULT_HUMAN_AGREEMENT * 100}%)${agreement.unknownPairs.length ? `; unknown pair ids: ${agreement.unknownPairs.join(', ')}` : ''}`,
      '',
    );
  }
  writeFileSync(f.report, lines.join('\n'));
  console.log(lines.join('\n'));
  return 0;
}

// ── export-human ─────────────────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function exportHuman(flags: Flags): number {
  const outDir = str(flags, 'out-dir')!;
  const perCell = flags['per-cell'] === undefined ? 10 : Number(flags['per-cell']);
  if (!(perCell > 0)) throw new Error('--per-cell must be positive');
  const f = files(outDir);
  const manifest = loadManifest(outDir);
  const seed = str(flags, 'seed', false) ?? manifest.taskSetFingerprint;
  const runs = latestBy(readJsonlRepairing<RunRecord>(f.runs), runKey);
  const judgements = readJsonlRepairing<PairJudgement>(f.judgements);
  const disputed = new Set(judgements.filter((j) => j.orderDisagreement).map((j) => j.taskId));
  // Pairs where two judges preferred different arms are disputed too.
  const prefs = new Map<string, Set<string>>();
  for (const j of judgements) prefs.set(j.taskId, (prefs.get(j.taskId) ?? new Set()).add(j.preference));
  for (const [taskId, set] of prefs) if (set.has('router') && set.has('incumbent')) disputed.add(taskId);

  const key: Record<string, { taskId: string; first: Arm }> = {};
  const sections: string[] = [];
  for (const cell of manifest.cells) {
    if (cell.identical) continue;
    const pairs = pairsFor(manifest, runs, cell).filter((p) => !runFailure(p.router, p.task) && !runFailure(p.incumbent, p.task));
    const ordered = [...pairs].sort((a, b) => pairId(seed, a.task.taskId).localeCompare(pairId(seed, b.task.taskId)));
    const chosen = [...ordered.slice(0, perCell), ...ordered.slice(perCell).filter((p) => disputed.has(p.task.taskId)).slice(0, perCell)];
    for (const p of chosen) {
      const id = pairId(seed, p.task.taskId);
      const first = humanFirstArm(seed, p.task.taskId);
      key[id] = { taskId: p.task.taskId, first };
      const [one, two] = first === 'router' ? [p.router, p.incumbent] : [p.incumbent, p.router];
      sections.push(`<section><h2>Pair ${id} (${escapeHtml(cell.taskType)})</h2><h3>Request</h3><pre>${escapeHtml(p.task.prompt)}</pre>${p.task.judgeNotes ? `<p><em>${escapeHtml(p.task.judgeNotes)}</em></p>` : ''}<div class="pair"><div><h3>Response 1</h3><pre>${escapeHtml(transcriptOf(one, p.task.requiredTools))}</pre></div><div><h3>Response 2</h3><pre>${escapeHtml(transcriptOf(two, p.task.requiredTools))}</pre></div></div></section>`);
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Router A/B blind review</title><style>body{font-family:system-ui,sans-serif;margin:16px;background:#fff;color:#111}pre{white-space:pre-wrap;background:#f5f5f5;padding:8px;font-size:13px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:800px){.pair{grid-template-columns:1fr}}section{border-top:2px solid #ccc;margin-top:24px}</style></head><body><h1>Router A/B blind review</h1><p>For each pair, record in human-ratings.csv which response is better (1, 2 or tie) and a 1-10 score for each, using the rubric you were given. Tool results were simulated: judge what the agent did and wrote, not the tool output. Do not try to work out which model wrote which response.</p>${sections.join('\n')}</body></html>`;
  writeFileSync(f.sheet, html);
  writeFileSync(f.key, JSON.stringify(key, null, 1), { mode: 0o600 });
  writeFileSync(f.ratings, `pairId,rater,better,score_1,score_2,notes\n${Object.keys(key).map((id) => `${id},,,,,`).join('\n')}\n`);
  console.log(`Wrote ${Object.keys(key).length} pairs: ${f.sheet} (give to raters), ${f.ratings} (template), ${f.key} (sealed: do not share until ratings are in)`);
  return 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: routerAbEval.ts plan|budget|generate|judge|report|export-human [flags] (see the header of this file)';

async function main(): Promise<number> {
  const { command, flags } = parseFlags(argv.slice(2));
  switch (command) {
    case 'plan': return plan(flags);
    case 'budget': return budget(flags);
    case 'generate': return generate(flags);
    case 'judge': return judge(flags);
    case 'report': return report(flags);
    case 'export-human': return exportHuman(flags);
    default: throw new Error(USAGE);
  }
}

if (require.main === module) {
  // Exit explicitly: the AWS and OpenRouter clients keep sockets open.
  main().then(
    (code) => exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    },
  );
}
