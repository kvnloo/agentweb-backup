/**
 * ENG-2649: blind quality-per-dollar A/B of the AgentWeb Model router against the current per-task defaults.
 * The logic is loops/eval/routerAb.ts (tested); this file wires it to the agent loop, the judge and the disk.
 *
 *   plan          free, offline: the cells, which judges may judge each, and the upper-bound spend.
 *   generate      PAID: runs every synthetic task once per arm, in-process on the Dev tables, tools in mock mode.
 *   judge         PAID: blind pairwise judging (both presentation orders) on OpenRouter, unmetered, cost-capped.
 *   report        free: per-cell summary and the pre-registered verdict; --human folds in blind human ratings.
 *   export-human  free: a blinded side-by-side sheet, its sealed key and a ratings template for human raters.
 *
 * Usage (from backend/):
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts plan --table <table.json> --incumbents <incumbents.json> [--tier Free]
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/routerAbEval.ts generate --table <t> --incumbents <i> \
 *     --user-id <Dev eval user> --out-dir <dir> --max-usd 150 [--tier Free] [--task-type report] [--limit 2]
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/routerAbEval.ts judge --out-dir <dir> --max-usd 50 \
 *     [--judges openrouter/openai/gpt-6-sol,anthropic.claude-sonnet-5]
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts report --out-dir <dir> [--judges <same as judge>] \
 *     [--human ratings.csv] [--reprice gemini-3.8-flash=1.5/7.5]
 *   (the first judge allowed for a cell decides it; the others are an agreement check)
 *   npx ts-node --transpile-only src/scripts/routerAbEval.ts export-human --out-dir <dir> [--per-cell 10]
 *
 * Safety: the paid commands refuse anything but NODE_ENV=development (Dev-* tables, the dev OpenRouter key), refuse a
 * user whose email is not on a reserved test domain (.example/.invalid/.test), refuse a task set not marked synthetic,
 * and stop before the call that would pass --max-usd (spend already recorded in --out-dir counts, so a resumed run
 * keeps the same cap). Every command resumes: finished runs and judgements are skipped.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { argv, exit } from 'node:process';
import {
  DEFAULT_DECISION_RULE,
  DEFAULT_HUMAN_AGREEMENT,
  DEFAULT_PRIMARY_JUDGE,
  DEFAULT_SECONDARY_JUDGE,
  GENERATION_PROFILE,
  ROUTER_AB_VERSION,
  SESSION_SHAPE,
  combineOrders,
  decideCell,
  estimateCost,
  flooredJudgement,
  humanAgreement,
  humanFirstArm,
  judgeProblem,
  judgeSystemPrompt,
  judgeUserContent,
  modelForArm,
  pairId,
  parseJudgeVerdict,
  resolveCells,
  runFailure,
  summarizeCell,
  taskSetFingerprint,
  taskSetProblems,
  transcriptOf,
  usageCostUsd,
  type AbTask,
  type Arm,
  type Cell,
  type HumanRating,
  type PairData,
  type PairJudgement,
  type RunRecord,
  type TurnUsage,
} from '../loops/eval/routerAb';
import { ROUTER_AB_TASK_SET_VERSION, buildSyntheticTaskSet } from '../loops/eval/routerAbTasks';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { registryRouterCatalog } from '../services/agentMode/agentWebModelRouterInstance';
import { getModelPrice, type ModelPrice } from '../utils/llmPricing';

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

/** The paid commands only ever run against the Dev tables and the dev OpenRouter key. */
export function requireDevelopment(nodeEnv: string | undefined): void {
  if (nodeEnv !== 'development') {
    throw new Error(`NODE_ENV is ${nodeEnv === undefined ? 'not set' : `"${nodeEnv}"`}: paid commands run only with NODE_ENV=development (Dev-* tables, dev OpenRouter key). Never production.`);
  }
}

const RESERVED_EMAIL = /@(?:[a-z0-9-]+\.)*(?:example|invalid|test)(?:\.(?:com|org|net))?$/i;

export function evalUserProblem(user: { email?: unknown } | null | undefined): string | undefined {
  if (!user) return 'the --user-id does not exist in the Dev users table';
  if (typeof user.email !== 'string' || !RESERVED_EMAIL.test(user.email)) {
    return 'the --user-id must be a dedicated eval account on a reserved test domain (.example/.invalid/.test), never a real user';
  }
  return undefined;
}

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

function plan(flags: Flags): void {
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
  // The spend estimate uses one judge per cell (the first allowed) plus the second where allowed.
  const estimate = estimateCost(tasks, judgedCells, [], profile);
  let judgeUsd = 0;
  for (const cell of judgedCells) {
    const one = estimateCost(tasks, [cell], judgesFor(cell, judges).allowed, profile);
    judgeUsd += one.judgeUsd;
  }
  console.log('\nUpper-bound spend (no prompt caching; replace the profile with pilot means via --profile):');
  for (const c of estimate.perCell) console.log(`  ${c.taskType.padEnd(9)} generation ${usd(c.generationUsd)} (${c.tasks} tasks x 2 arms)`);
  console.log(`  generation total ${usd(estimate.generationUsd)}, judging ${usd(judgeUsd)}, total ${usd(estimate.generationUsd + judgeUsd)}`);
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

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

function loadManifest(outDir: string): Manifest {
  const f = files(outDir).manifest;
  if (!existsSync(f)) throw new Error(`${f} not found: run generate first`);
  return readJson(f) as Manifest;
}

/** The latest record per key wins, so a rerun of a failed run or judgement replaces it. */
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

async function generate(flags: Flags): Promise<void> {
  requireDevelopment(process.env.NODE_ENV);
  const maxUsd = positiveUsd(flags, 'max-usd');
  const outDir = str(flags, 'out-dir')!;
  const userId = str(flags, 'user-id')!;
  const onlyType = str(flags, 'task-type', false);
  const limit = flags.limit === undefined ? Infinity : Number(flags.limit);
  if (!(limit > 0)) throw new Error('--limit must be a positive number of tasks per cell');
  const tasks = loadTasks(flags);
  const { cells, tier, tableVersion } = loadCells(flags);
  const { userDb } = await import('../services/db');
  const userProblem = evalUserProblem(await userDb.getUserById(userId));
  if (userProblem) throw new Error(userProblem);
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

  const { chatbotDb } = await import('../services/chatbotService');
  const { agentModeService } = await import('../services/agentModeService');
  const { skillService } = await import('../services/skillService');
  const publishedSkills = await skillService.getPublishedSkills();

  const allRuns = readJsonl<RunRecord>(f.runs);
  const done = latestBy(allRuns, runKey);
  const upperBound = (model: string, taskType: AbTask['taskType']) => {
    const p = GENERATION_PROFILE[taskType];
    return usageCostUsd(model, [{ promptTokens: p.inputTokens, completionTokens: p.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
  };
  // What a run cost against the cap. An errored run records no usage, but it may have spent tokens before failing,
  // so it is charged at the upper-bound profile. Every attempt counts, not only the latest per task.
  const charge = (r: RunRecord) => (r.status === 'ok' ? r.costUsd : upperBound(r.model, r.taskType));
  let spent = allRuns.reduce((sum, r) => sum + charge(r), 0);
  const observed = new Map<string, number[]>();
  for (const r of done.values()) if (r.status === 'ok') observed.set(r.model, [...(observed.get(r.model) ?? []), r.costUsd]);
  const nextEstimate = (model: string, task: AbTask) => {
    const seen = observed.get(model);
    return seen?.length ? seen.reduce((a, b) => a + b, 0) / seen.length : upperBound(model, task.taskType);
  };
  console.log(`generate: ${outDir}, spent so far ${usd(spent)} of ${usd(maxUsd)}`);

  for (const cell of cells) {
    if (cell.identical || (onlyType && cell.taskType !== onlyType)) continue;
    const shape = SESSION_SHAPE[cell.taskType];
    if (!shape) {
      console.log(`${cell.taskType}: skipped, not runnable in-process`);
      continue;
    }
    const cellTasks = tasks.filter((t) => t.taskType === cell.taskType).slice(0, limit);
    for (const task of cellTasks) {
      for (const arm of ['router', 'incumbent'] as const) {
        const prior = done.get(runKey({ taskId: task.taskId, arm }));
        if (prior?.status === 'ok') continue;
        const model = modelForArm(cell, arm);
        if (spent + nextEstimate(model, task) > maxUsd) {
          console.log(`stopped before ${task.taskId}/${arm}: the next run would pass --max-usd (${usd(spent)} spent)`);
          return;
        }
        const record = await runOne(task, arm, model, userId, shape, { chatbotDb, agentModeService, publishedSkills });
        appendFileSync(f.runs, `${JSON.stringify(record)}\n`);
        spent += charge(record);
        if (record.status === 'ok') observed.set(model, [...(observed.get(model) ?? []), record.costUsd]);
        const failure = runFailure(record, task);
        console.log(`${task.taskId} ${arm} ${model} ${failure ? `FAILED (${failure.slice(0, 120)})` : 'ok'} ${usd(record.costUsd)} ${(record.latencyMs / 1000).toFixed(1)}s total ${usd(spent)}`);
      }
    }
  }
  console.log(`generate done: ${usd(spent)} spent`);
}

async function runOne(
  task: AbTask,
  arm: Arm,
  model: string,
  userId: string,
  shape: { sessionType: string; portalType: string },
  deps: { chatbotDb: any; agentModeService: any; publishedSkills: Array<{ skillId: string; toolNames?: string[] }> },
): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = { taskId: task.taskId, taskType: task.taskType, arm, model, startedAt };
  try {
    const session = await deps.chatbotDb.createChatSession(
      userId, undefined, shape.portalType, 'agent-mode', undefined, undefined, undefined, undefined, shape.sessionType, undefined,
      { llmModel: model, llmModelSource: 'system' },
    );
    // As runVerifiedChat does for required functions: install the published skills that carry them.
    const required = new Set(task.requiredTools);
    const skillIds = deps.publishedSkills.filter((s) => s.toolNames?.some((t) => required.has(t))).map((s) => s.skillId);
    if (skillIds.length) await deps.agentModeService.installSkills(skillIds, userId, session.sessionId);
    // mockMode = true: every tool returns its simulated result, nothing leaves the sandbox (no sends, posts, image or
    // video generation), and both arms see identical tool results.
    const res = await deps.agentModeService.generateMarketingResponse(task.prompt, [], userId, model, session.sessionId, true);
    const harvested = harvestResponse(res.responseMessages);
    return {
      ...base,
      ...harvested,
      status: 'ok',
      finalText: typeof res.content === 'string' ? res.content : '',
      costUsd: usageCostUsd(model, harvested.usage),
      latencyMs: Date.now() - t0,
    };
  } catch (error) {
    return {
      ...base,
      ranModels: [],
      status: 'error',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      finalText: '',
      toolCalls: [],
      usage: [],
      costUsd: 0,
      latencyMs: Date.now() - t0,
    };
  }
}

// ── judge ────────────────────────────────────────────────────────────────────

function pairsFor(manifest: Manifest, runs: Map<string, RunRecord>, cell: Cell): Array<{ task: AbTask; router: RunRecord; incumbent: RunRecord }> {
  const out: Array<{ task: AbTask; router: RunRecord; incumbent: RunRecord }> = [];
  for (const task of manifest.tasks.filter((t) => t.taskType === cell.taskType)) {
    const router = runs.get(runKey({ taskId: task.taskId, arm: 'router' }));
    const incumbent = runs.get(runKey({ taskId: task.taskId, arm: 'incumbent' }));
    if (router && incumbent) out.push({ task, router, incumbent });
  }
  return out;
}

async function judge(flags: Flags): Promise<void> {
  requireDevelopment(process.env.NODE_ENV);
  const maxUsd = positiveUsd(flags, 'max-usd');
  const outDir = str(flags, 'out-dir')!;
  const f = files(outDir);
  const manifest = loadManifest(outDir);
  const judges = judgeList(flags);
  const runs = latestBy(readJsonl<RunRecord>(f.runs), runKey);
  const done = latestBy(readJsonl<StoredJudgement>(f.judgements), judgeKey);

  const { agentModeService } = await import('../services/agentModeService');
  const { resolveOpenRouterUpstreamModelId } = await import('../utils/openRouterGatewayContract');
  const { readChatCompletion } = await import('../services/creativeRubricJudge');
  const { requireReportedCostUsd } = await import('./runTaskSuccessJudgeTrial');
  const client = await agentModeService.getOpenRouterClient();
  // Spend already recorded in --out-dir counts against the cap, so a resumed run keeps the same total.
  const priorUsd = [...readJsonl<{ costUsd?: number }>(f.judgements), ...readJsonl<{ costUsd?: number }>(f.judgeErrors)]
    .reduce((sum, r) => sum + (typeof r.costUsd === 'number' ? r.costUsd : 0), 0);
  const cost = { usd: priorUsd, calls: 0, sessionUsd: 0 };
  // Unmetered on purpose (as runTaskSuccessJudgeTrial): eval spend is not any customer's usage. Cost comes from
  // OpenRouter's own report; a call that reports none stops the run, since the cap cannot work blind.
  const complete = async (model: string, system: string, user: string): Promise<string> => {
    const res = (await client.chat.completions.create(
      {
        model: resolveOpenRouterUpstreamModelId(model),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(LLM_MODEL_REGISTRY[model]?.supportsTemperature === false ? {} : { temperature: 0 }),
        max_tokens: 8_000,
        usage: { include: true },
      } as Parameters<typeof client.chat.completions.create>[0],
      { timeout: 180_000 },
    )) as any;
    const callUsd = requireReportedCostUsd(res);
    cost.usd += callUsd;
    cost.sessionUsd += callUsd;
    cost.calls += 1;
    return readChatCompletion(res).text;
  };

  for (const cell of manifest.cells) {
    if (cell.identical) continue;
    const { allowed, refused } = judgesFor(cell, judges);
    for (const r of refused) console.log(`${cell.taskType}: ${r}`);
    for (const judgeModel of allowed) {
      for (const pair of pairsFor(manifest, runs, cell)) {
        if (currentJudgement(done.get(judgeKey({ taskId: pair.task.taskId, judge: judgeModel })), pair)) continue;
        const rFail = Boolean(runFailure(pair.router, pair.task));
        const iFail = Boolean(runFailure(pair.incumbent, pair.task));
        let judgement: PairJudgement;
        const before = cost.usd;
        try {
          if (rFail || iFail) {
            judgement = flooredJudgement(pair.task, judgeModel, rFail, iFail);
          } else {
            const perCall = cost.calls ? cost.sessionUsd / cost.calls : 0;
            if (cost.usd + 2 * perCall > maxUsd) {
              console.log(`stopped at the cost cap (${usd(cost.usd)} recorded in ${outDir})`);
              return;
            }
            const system = judgeSystemPrompt(cell.taskType);
            const a = parseJudgeVerdict(await complete(judgeModel, system, judgeUserContent(pair.task, pair.router, pair.incumbent)));
            const b = parseJudgeVerdict(await complete(judgeModel, system, judgeUserContent(pair.task, pair.incumbent, pair.router)));
            judgement = combineOrders(pair.task, judgeModel, a, b);
          }
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          if (/reported no cost/.test(message)) throw error;
          appendFileSync(f.judgeErrors, `${JSON.stringify({ taskId: pair.task.taskId, judge: judgeModel, error: message, costUsd: cost.usd - before, at: new Date().toISOString() })}\n`);
          console.log(`${pair.task.taskId} ${judgeModel} ERROR ${message}`);
          continue;
        }
        const stored: StoredJudgement = { ...judgement, runs: { router: pair.router.startedAt, incumbent: pair.incumbent.startedAt }, costUsd: cost.usd - before };
        appendFileSync(f.judgements, `${JSON.stringify(stored)}\n`);
        console.log(`${pair.task.taskId} ${judgeModel} ${judgement.preference}${judgement.floored ? ' (floored)' : ''} r=${judgement.routerScore} i=${judgement.incumbentScore} ${usd(cost.usd)}`);
      }
    }
  }
  console.log(`judge done: ${cost.calls} calls this session (${usd(cost.sessionUsd)}), ${usd(cost.usd)} recorded in ${outDir}`);
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
  return [
    `### ${title}: ${d.verdict.toUpperCase()}`,
    `router ${s.routerModel} vs incumbent ${s.incumbentModel}, judge ${judgeModel}, ${s.n} judged pairs (${s.judgeErrors} judge errors)`,
    '',
    '| metric | router | incumbent |',
    '|---|---|---|',
    `| failure rate | ${pct(s.failures.routerRate)} (${s.failures.router}) | ${pct(s.failures.incumbentRate)} (${s.failures.incumbent}) |`,
    `| severe (judge) | ${s.severe.router} | ${s.severe.incumbent} |`,
    `| mean score (1-10) | ${s.meanScore.router.toFixed(2)} | ${s.meanScore.incumbent.toFixed(2)} |`,
    `| mean cost per task | $${s.meanCostUsd.router.toFixed(4)} | $${s.meanCostUsd.incumbent.toFixed(4)} |`,
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

function report(flags: Flags): void {
  const outDir = str(flags, 'out-dir')!;
  const f = files(outDir);
  const manifest = loadManifest(outDir);
  const runs = latestBy(readJsonl<RunRecord>(f.runs), runKey);
  const judgements = latestBy(readJsonl<StoredJudgement>(f.judgements), judgeKey);
  const errors = latestBy(readJsonl<{ taskId: string; judge: string; error: string }>(f.judgeErrors), judgeKey);
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
        const reprice1 = (r: RunRecord): RunRecord => (reprice[r.model] ? { ...r, costUsd: usageCostUsd(r.model, r.usage, reprice[r.model]) } : r);
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
}

// ── export-human ─────────────────────────────────────────────────────────────

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function exportHuman(flags: Flags): void {
  const outDir = str(flags, 'out-dir')!;
  const perCell = flags['per-cell'] === undefined ? 10 : Number(flags['per-cell']);
  if (!(perCell > 0)) throw new Error('--per-cell must be positive');
  const f = files(outDir);
  const manifest = loadManifest(outDir);
  const seed = str(flags, 'seed', false) ?? manifest.taskSetFingerprint;
  const runs = latestBy(readJsonl<RunRecord>(f.runs), runKey);
  const judgements = readJsonl<PairJudgement>(f.judgements);
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
      sections.push(`<section><h2>Pair ${id} (${escapeHtml(cell.taskType)})</h2><h3>Request</h3><pre>${escapeHtml(p.task.prompt)}</pre>${p.task.judgeNotes ? `<p><em>${escapeHtml(p.task.judgeNotes)}</em></p>` : ''}<div class="pair"><div><h3>Response 1</h3><pre>${escapeHtml(transcriptOf(one))}</pre></div><div><h3>Response 2</h3><pre>${escapeHtml(transcriptOf(two))}</pre></div></div></section>`);
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Router A/B blind review</title><style>body{font-family:system-ui,sans-serif;margin:16px;background:#fff;color:#111}pre{white-space:pre-wrap;background:#f5f5f5;padding:8px;font-size:13px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:800px){.pair{grid-template-columns:1fr}}section{border-top:2px solid #ccc;margin-top:24px}</style></head><body><h1>Router A/B blind review</h1><p>For each pair, record in human-ratings.csv which response is better (1, 2 or tie) and a 1-10 score for each, using the rubric you were given. Tool results were simulated: judge what the agent did and wrote, not the tool output. Do not try to work out which model wrote which response.</p>${sections.join('\n')}</body></html>`;
  writeFileSync(f.sheet, html);
  writeFileSync(f.key, JSON.stringify(key, null, 1), { mode: 0o600 });
  writeFileSync(f.ratings, `pairId,rater,better,score_1,score_2,notes\n${Object.keys(key).map((id) => `${id},,,,,`).join('\n')}\n`);
  console.log(`Wrote ${Object.keys(key).length} pairs: ${f.sheet} (give to raters), ${f.ratings} (template), ${f.key} (sealed: do not share until ratings are in)`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: routerAbEval.ts plan|generate|judge|report|export-human [flags] (see the header of this file)';

async function main(): Promise<void> {
  const { command, flags } = parseFlags(argv.slice(2));
  switch (command) {
    case 'plan': return plan(flags);
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
    () => exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      exit(1);
    },
  );
}
