/**
 * ENG-2649: the router A/B harness. These pin what makes its verdict trustworthy: the arms are exactly what the
 * router and today's defaults run, the task set stays synthetic, cost uses the price book, the judge is blind and
 * family-independent, a failed run can never look like a win, the decision rule is the pre-registered one, and the
 * paid commands cannot touch production or a real user.
 */
import {
  AGENTWEB_TASK_TYPES,
  taskTypeForSession,
} from '../services/agentMode/agentWebModelRouter';
import { registryRouterCatalog } from '../services/agentMode/agentWebModelRouterInstance';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { MODEL_PRICING } from '../utils/llmPricing';
import {
  DEFAULT_DECISION_RULE,
  SESSION_SHAPE,
  VERIFIED_CHAT_MAX_ATTEMPTS,
  callUpperBoundUsd,
  isReservedDomain,
  missingRequiredTools,
  sampleAcrossTemplates,
  verifiedChatRetryMessage,
  combineOrders,
  decideCell,
  estimateCost,
  flooredJudgement,
  humanAgreement,
  humanFirstArm,
  judgeProblem,
  pairId,
  parseJudgeVerdict,
  redactModelNames,
  resolveCells,
  runFailure,
  summarizeCell,
  taskSetFingerprint,
  taskSetProblems,
  transcriptOf,
  usageCostUsd,
  type AbTask,
  type Cell,
  type JudgeVerdict,
  type PairData,
  type RunRecord,
} from '../loops/eval/routerAb';
import { buildSyntheticTaskSet, syntheticPerformanceTable } from '../loops/eval/routerAbTasks';
import {
  evalUserProblem,
  harvestResponse,
  openRouterKeySource,
  parseFlags,
  parseHumanCsv,
  parseReprice,
  repricedCostUsd,
  requireDevelopment,
  runVerified,
  s3BucketProblem,
  skillEntitlementProblems,
  toolRegistryProblems,
} from '../scripts/routerAbEval';
import { BudgetExceededError, BudgetLedger, CostMeter, readJsonlRepairing, reportedCostUsd } from '../loops/eval/routerAbBudget';
import { appendFileSync, existsSync, mkdtempSync, readFileSync as readFile, rmSync, writeFileSync } from 'fs';
import os from 'os';
import { readFileSync } from 'fs';
import path from 'path';

const ARTIFACTS = path.join(__dirname, '../../eval-artifacts/router-ab');
const table: unknown = JSON.parse(readFileSync(path.join(ARTIFACTS, 'routing-table-v0.json'), 'utf8'));
const incumbents: Record<string, string> = JSON.parse(readFileSync(path.join(ARTIFACTS, 'incumbents.eng-2649.json'), 'utf8'));

const providerOf = (m: string) => LLM_MODEL_REGISTRY[m]?.provider;

function task(overrides: Partial<AbTask> = {}): AbTask {
  return { taskId: 't1', taskType: 'image', synthetic: true, brand: 'Brightloom Candles', prompt: 'Create a square ad for https://brightloom.example now.', requiredTools: ['generate_image'], ...overrides };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    taskId: 't1', taskType: 'image', arm: 'router', model: 'gemini-3.8-flash', ranModels: ['gemini-3.8-flash'], status: 'ok',
    finalText: 'Here is your ad.', toolCalls: [{ name: 'generate_image', args: '{"prompt":"x"}' }], attempts: 1, usage: [], calls: [], costUsd: 0.1,
    latencyMs: 1000, startedAt: '2026-10-23T00:00:00.000Z', ...overrides,
  };
}

const verdict = (v: Partial<JudgeVerdict>): JudgeVerdict => ({ score1: 7, score2: 7, severe1: false, severe2: false, better: 'tie', reason: '', ...v });

describe('synthetic task set', () => {
  const tasks = buildSyntheticTaskSet();

  it('is 40 synthetic tasks for each of report, support, image and video, with no usability problems', () => {
    expect(taskSetProblems(tasks)).toEqual([]);
    for (const type of ['report', 'support', 'image', 'video']) expect(tasks.filter((t) => t.taskType === type)).toHaveLength(40);
    expect(tasks.every((t) => t.synthetic === true)).toBe(true);
  });

  it('is deterministic (same fingerprint and seeded figures on every build)', () => {
    expect(taskSetFingerprint(buildSyntheticTaskSet())).toBe(taskSetFingerprint(tasks));
    expect(syntheticPerformanceTable(3)).toBe(syntheticPerformanceTable(3));
    expect(syntheticPerformanceTable(3)).not.toBe(syntheticPerformanceTable(4));
  });

  it('refuses a task that is not marked synthetic or names a real domain or email', () => {
    expect(taskSetProblems([task({ synthetic: false as unknown as true })])).toEqual(['t1: not marked synthetic']);
    expect(taskSetProblems([task({ prompt: 'Write an ad for https://www.realshop.com please' })])[0]).toMatch(/non-reserved domain \(www\.realshop\.com\)/);
    expect(taskSetProblems([task({ prompt: 'Email the owner at jane@realshop.co.uk about it' })])[0]).toMatch(/non-reserved domain \(realshop\.co\.uk\)/);
    expect(taskSetProblems([task(), task()])).toContain('duplicate taskId t1');
  });
});

describe('arms', () => {
  it('creates each session so the router classifies it as the task type under test; scheduled is not runnable in-process', () => {
    for (const type of AGENTWEB_TASK_TYPES) {
      const shape = SESSION_SHAPE[type];
      if (type === 'scheduled') expect(shape).toBeNull();
      else expect(taskTypeForSession(shape!)).toBe(type);
    }
  });

  it('v0 table vs the ENG-2649 incumbents: chat and scheduled identical, four cells to measure', () => {
    const { cells, errors } = resolveCells(table, null, incumbents, registryRouterCatalog);
    expect(errors).toEqual([]);
    const byType = Object.fromEntries(cells.map((c) => [c.taskType, c]));
    expect(byType.chat.identical).toBe(true);
    expect(byType.scheduled.identical).toBe(true);
    expect(byType.report).toMatchObject({ identical: false, router: { model: 'anthropic.claude-sonnet-5', reason: 'report task: table route' }, incumbent: { model: 'gemini-3.1-pro-preview' } });
    for (const t of ['support', 'image', 'video']) {
      expect(byType[t]).toMatchObject({ identical: false, router: { model: 'gemini-3.8-flash' }, incumbent: { model: 'gemini-3.1-pro-preview' } });
    }
  });

  it('applies the tier override exactly as the router does (Free reports route to gemini-3.8-flash)', () => {
    const report = resolveCells(table, 'Free', incumbents, registryRouterCatalog).cells.find((c) => c.taskType === 'report')!;
    expect(report.router).toEqual({ model: 'gemini-3.8-flash', reason: 'report task: plan route' });
  });

  it('refuses an incumbent that is not a registered model and an unusable table', () => {
    expect(resolveCells(table, null, { report: 'no-such-model' }, registryRouterCatalog).errors).toEqual(['incumbents: report -> no-such-model is not a registered model']);
    expect(resolveCells({ routes: {} }, null, incumbents, registryRouterCatalog).errors[0]).toMatch(/^routing table: /);
  });
});

describe('cost', () => {
  it('prices usage from MODEL_PRICING, cache reads and writes included', () => {
    const p = MODEL_PRICING['anthropic.claude-sonnet-5'];
    const usd = usageCostUsd('anthropic.claude-sonnet-5', [
      { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { promptTokens: 0, completionTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
    ]);
    expect(usd).toBeCloseTo(p.inPerM + p.outPerM + p.cacheReadPerM! + p.cacheWritePerM!, 9);
  });

  it('refuses an unpriced model rather than reporting $0', () => {
    expect(() => usageCostUsd('no-such-model', [])).toThrow(/no MODEL_PRICING entry/);
  });

  it('re-prices for a sensitivity run, scaling the cache rates with the input rate', () => {
    const reprice = parseReprice('gemini-3.8-flash=1.5/7.5');
    expect(reprice['gemini-3.8-flash']).toMatchObject({ inPerM: 1.5, outPerM: 7.5 });
    const u = [{ promptTokens: 1_000_000, completionTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }];
    expect(usageCostUsd('gemini-3.8-flash', u, reprice['gemini-3.8-flash'])).toBeCloseTo(9, 9);
    expect(() => parseReprice('gemini-3.8-flash=cheap')).toThrow(/model=in\/out/);
  });

  it('estimates nothing for an identical cell and both arms plus two judge calls per pair otherwise', () => {
    const tasks = buildSyntheticTaskSet();
    const { cells } = resolveCells(table, null, incumbents, registryRouterCatalog);
    const est = estimateCost(tasks, cells, ['openrouter/openai/gpt-6-sol']);
    expect(est.perCell.map((c) => c.taskType).sort()).toEqual(['image', 'report', 'support', 'video']);
    expect(est.totalUsd).toBeGreaterThan(0);
  });
});

describe('judge eligibility and blinding', () => {
  it('only a judge from a provider that wrote neither arm may judge a cell', () => {
    expect(judgeProblem('openrouter/openai/gpt-6-sol', ['anthropic.claude-sonnet-5', 'anthropic.claude-sonnet-4-6'], providerOf)).toBeUndefined();
    expect(judgeProblem('anthropic.claude-sonnet-5', ['anthropic.claude-sonnet-5', 'anthropic.claude-sonnet-4-6'], providerOf)).toMatch(/same provider/);
    expect(judgeProblem('anthropic.claude-sonnet-5', ['gemini-3.8-flash', 'gemini-3.1-pro-preview'], providerOf)).toBeUndefined();
    expect(judgeProblem('openrouter/openai/gpt-6-sol', ['gemini-3.8-flash', 'anthropic.claude-sonnet-4-6'], providerOf)).toBeUndefined();
    expect(judgeProblem('nope', ['gemini-3.8-flash'], providerOf)).toMatch(/not a registered model/);
  });

  it('strips model self-identification from what the judge and raters see', () => {
    expect(redactModelNames('As Gemini (by Google DeepMind), not Claude Sonnet 5 or GPT-5.4, I wrote this.')).toBe('As [model] (by [model]), not [model] or [model], I wrote this.');
    const shown = transcriptOf(run({ finalText: 'Generated with gemini-3.8-flash.' }), ['generate_image']);
    expect(shown).toContain('Generated with [model].');
    expect(shown).toContain('generate_image [deliverable]:\nprompt: x');
  });

  it('pair ids are opaque and the human-sheet order is seed-dependent and balanced', () => {
    expect(pairId('s', 'report-t1-solace')).toMatch(/^[0-9a-f]{10}$/);
    expect(pairId('s', 'a')).not.toBe(pairId('s2', 'a'));
    const firsts = buildSyntheticTaskSet().map((t) => humanFirstArm('seed', t.taskId));
    const routerFirst = firsts.filter((a) => a === 'router').length;
    expect(routerFirst).toBeGreaterThan(50);
    expect(routerFirst).toBeLessThan(110);
  });
});

describe('judge output', () => {
  it('parses a fenced JSON verdict and rejects anything out of range', () => {
    const v = parseJudgeVerdict('```json\n{"checklist":[],"score_1":8,"score_2":6,"severe_1":false,"severe_2":true,"better":"1","reason":"ok"}\n```');
    expect(v).toEqual({ score1: 8, score2: 6, severe1: false, severe2: true, better: '1', reason: 'ok' });
    expect(() => parseJudgeVerdict('{"score_1":11,"score_2":6,"severe_1":false,"severe_2":false,"better":"1"}')).toThrow(/score_1/);
    expect(() => parseJudgeVerdict('{"score_1":8,"score_2":6,"severe_1":false,"severe_2":false,"better":"A"}')).toThrow(/better/);
    expect(() => parseJudgeVerdict('no json')).toThrow(/no JSON/);
  });

  it('folds both presentation orders: agreement stands, opposite preferences are position bias (tie)', () => {
    const t = task();
    // Router first: "1" is the router. Incumbent first: "2" is the router.
    const agree = combineOrders(t, 'j', verdict({ score1: 8, score2: 6, better: '1' }), verdict({ score1: 5, score2: 9, better: '2' }));
    expect(agree).toMatchObject({ preference: 'router', routerScore: 8.5, incumbentScore: 5.5, orderDisagreement: false });
    const bias = combineOrders(t, 'j', verdict({ better: '1' }), verdict({ better: '1' }));
    expect(bias).toMatchObject({ preference: 'tie', orderDisagreement: true });
    const lean = combineOrders(t, 'j', verdict({ better: 'tie' }), verdict({ better: '1', severe1: true }));
    expect(lean).toMatchObject({ preference: 'incumbent', incumbentSevere: true, routerSevere: false });
  });
});

describe('failures', () => {
  it('a substituted model, a missing required tool or an error is a failure; a clean run is not', () => {
    const t = task();
    expect(runFailure(run(), t)).toBeUndefined();
    expect(runFailure(run({ ranModels: ['gemini-3.8-flash', 'gpt-5.5'] }), t)).toMatch(/model substituted/);
    expect(runFailure(run({ toolCalls: [] }), t)).toMatch(/required tool not called: generate_image/);
    expect(runFailure(run({ status: 'error', error: 'timeout' }), t)).toBe('error: timeout');
    expect(runFailure(run({ ranModels: [] }), t)).toMatch(/no assistant message/);
  });

  it('a failed arm scores the floor and loses; it can never read as a win', () => {
    expect(flooredJudgement(task(), 'j', true, false)).toMatchObject({ preference: 'incumbent', routerScore: 1, routerSevere: true, floored: true });
    expect(flooredJudgement(task(), 'j', true, true)).toMatchObject({ preference: 'tie', routerScore: 1, incumbentScore: 1 });
    expect(() => flooredJudgement(task(), 'j', false, false)).toThrow();
  });

  it('harvests the concrete model, usage and tool calls from the turn', () => {
    const h = harvestResponse([
      { role: 'assistant', llm: 'gemini-3.8-flash', usage: { prompt_tokens: 10, completion_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, tool_calls: [{ function: { name: 'generate_image', arguments: '{"a":1}' } }] },
      { role: 'tool', content: 'mock' },
      { role: 'assistant', llm: 'gemini-3.8-flash', content: 'done' },
    ]);
    expect(h).toEqual({
      ranModels: ['gemini-3.8-flash'],
      usage: [{ promptTokens: 10, completionTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }],
      toolCalls: [{ name: 'generate_image', args: '{"a":1}' }],
    });
  });
});

describe('decision rule', () => {
  const cell: Cell = { taskType: 'image', router: { model: 'gemini-3.8-flash', reason: 'image task: table route' }, incumbent: { model: 'gemini-3.1-pro-preview' }, identical: false };

  function pairs(n: number, f: (i: number) => { r: number; i: number; rCost: number; iCost: number; rFail?: boolean }): PairData[] {
    return Array.from({ length: n }, (_, k) => {
      const x = f(k);
      const t = task({ taskId: `t${k}` });
      const router = run({ taskId: t.taskId, costUsd: x.rCost, ...(x.rFail ? { status: 'error' as const, error: 'boom' } : {}) });
      const incumbent = run({ taskId: t.taskId, arm: 'incumbent', model: 'gemini-3.1-pro-preview', ranModels: ['gemini-3.1-pro-preview'], costUsd: x.iCost });
      const judgement = x.rFail
        ? flooredJudgement(t, 'j', true, false)
        : combineOrders(t, 'j', verdict({ score1: x.r, score2: x.i, better: x.r > x.i ? '1' : x.r < x.i ? '2' : 'tie' }), verdict({ score1: x.i, score2: x.r, better: x.r > x.i ? '2' : x.r < x.i ? '1' : 'tie' }));
      return { task: t, router, incumbent, judgement };
    });
  }

  it('passes a cheaper router of equal quality', () => {
    const s = summarizeCell(cell, 'j', pairs(40, (k) => ({ r: 7 + (k % 2), i: 7 + ((k + 1) % 2), rCost: 0.1, iCost: 0.3 })));
    expect(decideCell(s)).toEqual({ verdict: 'pass', reasons: ['every criterion met'] });
    expect(s.qpd.ratio).toBeCloseTo(3, 1);
  });

  it('fails a cheaper router that is clearly worse (non-inferiority margin), even though quality-per-dollar is higher', () => {
    const s = summarizeCell(cell, 'j', pairs(40, () => ({ r: 4, i: 7, rCost: 0.1, iCost: 0.3 })));
    const d = decideCell(s);
    expect(d.verdict).toBe('fail');
    expect(d.reasons.join(' ')).toMatch(/score diff CI lower/);
    expect(d.reasons.join(' ')).toMatch(/win rate/);
  });

  it('fails an equally good router that costs more (quality per dollar)', () => {
    const s = summarizeCell(cell, 'j', pairs(40, () => ({ r: 7, i: 7, rCost: 0.4, iCost: 0.3 })));
    expect(decideCell(s).reasons.join(' ')).toMatch(/quality-per-dollar ratio 0\.75 < 1/);
  });

  it('fails a router that errors more often, and the failures count against its quality', () => {
    const s = summarizeCell(cell, 'j', pairs(40, (k) => ({ r: 7, i: 7, rCost: 0.1, iCost: 0.3, rFail: k < 4 })));
    expect(s.failures.routerRate).toBeCloseTo(0.1, 9);
    expect(decideCell(s).reasons.join(' ')).toMatch(/failure rate \+10\.0 pp/);
  });

  it('is inconclusive below the pre-registered sample size', () => {
    const s = summarizeCell(cell, 'j', pairs(20, () => ({ r: 7, i: 7, rCost: 0.1, iCost: 0.3 })));
    expect(decideCell(s, DEFAULT_DECISION_RULE)).toEqual({ verdict: 'inconclusive', reasons: ['20 judged pairs < 36 required'] });
  });
});

describe('human validation', () => {
  it('maps the sheet position back to the arm before comparing with the judge', () => {
    const key = { p1: { taskId: 'a', first: 'router' as const }, p2: { taskId: 'b', first: 'incumbent' as const } };
    const judged = [
      { ...flooredJudgement(task({ taskId: 'a' }), 'j', false, true) }, // router preferred
      { ...flooredJudgement(task({ taskId: 'b' }), 'j', false, true) }, // router preferred
    ];
    const ratings = parseHumanCsv('pairId,rater,better,score_1,score_2,notes\np1,ana,1,8,6,\np2,ana,2,5,8,"fine, really"\npX,ana,1,,,\n');
    expect(humanAgreement(ratings, key, judged)).toEqual({ compared: 2, agreed: 2, rate: 1, unknownPairs: ['pX'] });
    expect(() => parseHumanCsv('h\np1,ana,maybe')).toThrow(/must be 1, 2 or tie/);
  });
});

describe('CLI safety', () => {
  it('paid commands run only with NODE_ENV=development', () => {
    expect(() => requireDevelopment('development')).not.toThrow();
    for (const env of ['production', 'staging', undefined]) expect(() => requireDevelopment(env)).toThrow(/Never production/);
  });

  it('refuses a missing user or one that is not on a reserved test domain', () => {
    expect(evalUserProblem({ email: 'router-ab-eval@agentweb.invalid' })).toBeUndefined();
    expect(evalUserProblem({ email: 'router-ab@eval.example' })).toBeUndefined();
    expect(evalUserProblem({ email: 'test@example.com' })).toMatch(/shared QA account/);
    expect(evalUserProblem({ email: 'qa@test.com' })).toMatch(/never a real user/);
    expect(evalUserProblem({ email: 'router-ab@agentweb.invalid', isAdmin: true })).toMatch(/admin/);
    expect(evalUserProblem({ email: 'owner@realcustomer.com' })).toMatch(/never a real user/);
    expect(evalUserProblem({ email: 'x@example.com.attacker.io' })).toMatch(/never a real user/);
    expect(evalUserProblem(null)).toMatch(/does not exist/);
  });

  it('parses commands and flags', () => {
    expect(parseFlags(['generate', '--budget-file', 'b.jsonl', '--tier', 'Free', '--dry'])).toEqual({ command: 'generate', flags: { 'budget-file': 'b.jsonl', tier: 'Free', dry: true } });
    expect(() => parseFlags(['plan', 'stray'])).toThrow(/unexpected argument/);
  });
});

describe('reserved domains', () => {
  it('accepts only RFC 2606/6761 names', () => {
    for (const h of ['a.example', 'x.test', 'y.invalid', 'localhost', 'example.com', 'shop.example.org', 'a.b.example.net']) expect(isReservedDomain(h)).toBe(true);
    for (const h of ['test.com', 'invalid.org', 'example.com.attacker.io', 'notexample.com', 'test.co.uk', 'a_b.example']) expect(isReservedDomain(h)).toBe(false);
  });
});

describe('environment refusals', () => {
  it('refuses an unset or production S3 bucket', () => {
    expect(s3BucketProblem(undefined)).toMatch(/not set/);
    expect(s3BucketProblem('agentweb-user-files')).toMatch(/production/);
    expect(s3BucketProblem('agentweb-user-files-dev')).toBeUndefined();
  });

  it('refuses an exported OPENROUTER_API_KEY unless explicitly allowed', () => {
    expect(openRouterKeySource({ OPENROUTER_API_KEY: 'k' }, false)).toHaveProperty('problem');
    expect(openRouterKeySource({ OPENROUTER_API_KEY: 'k' }, true)).toHaveProperty('source');
    expect(openRouterKeySource({}, false)).toHaveProperty('source');
  });

  it('refuses a tier that cannot run the required skills', () => {
    const skills = [{ skillId: 's1', toolNames: ['create_blog_article'] }];
    expect(skillEntitlementProblems(['create_blog_article'], skills, ['other'])).toHaveLength(1);
    expect(skillEntitlementProblems(['create_blog_article'], skills, ['s1'])).toEqual([]);
    expect(skillEntitlementProblems(['create_blog_article'], skills, ['*'])).toEqual([]);
    expect(skillEntitlementProblems([], skills, null)).toHaveLength(1);
  });

  it('refuses to generate from an uninitialized agent-mode tool registry (install_skills "Unknown tool")', () => {
    const empty = { toolRegistry: { getTool: () => undefined } };
    const ready = { toolRegistry: { getTool: (n: string) => (n === 'install_skills' ? {} : undefined) } };
    expect(toolRegistryProblems(empty)).toEqual(['install_skills is not registered after initialize()']);
    expect(toolRegistryProblems(ready)).toEqual([]);
    expect(toolRegistryProblems({})).toHaveLength(1);
    expect(toolRegistryProblems(ready, ['install_skills', 'generate_image'])).toEqual(['generate_image is not registered after initialize()']);
  });
});

describe('transcripts and sampling', () => {
  it('never truncates the required tool\'s arguments (the report is in content_draft); other tools are clipped', () => {
    const draft = 'word '.repeat(10_000);
    const r = run({ toolCalls: [{ name: 'create_blog_article', args: JSON.stringify({ content_draft: draft }) }, { name: 'other', args: JSON.stringify({ x: 'y'.repeat(20_000) }) }], finalText: 'z'.repeat(30_000) });
    const text = transcriptOf(r, ['create_blog_article']);
    expect(text).toContain(draft);
    expect(text).toContain('[deliverable]');
    expect(text).toMatch(/\[truncated \d+ chars\]/);
    expect(text).toContain('z'.repeat(30_000));
  });

  it('redacts more model makers and hosts', () => {
    const out = redactModelNames('Gemma 3, Bard, Google Vertex AI, AWS Bedrock, Grok 4 and Google Search Ads');
    expect(out).not.toMatch(/gemma|bard|vertex|bedrock|grok/i);
    expect(out).toContain('Google Search Ads');
  });

  it('a limit samples across templates', () => {
    const tasks = buildSyntheticTaskSet().filter((t) => t.taskType === 'report');
    const picked = sampleAcrossTemplates(tasks, 2);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((t) => t.template)).size).toBe(2);
    expect(sampleAcrossTemplates(tasks)).toHaveLength(tasks.length);
  });
});

describe('verified-chat retries', () => {
  const t = task({ taskType: 'report', requiredTools: ['create_blog_article'] });
  const call = { role: 'assistant', llm: 'm', content: 'done', tool_calls: [{ function: { name: 'create_blog_article', arguments: '{}' } }] };
  const skip = { role: 'assistant', llm: 'm', content: 'Here is a plan' };

  it('re-prompts like the product when the required tool is skipped, up to 5 turns', async () => {
    const messages: string[] = [];
    const out = await runVerified(t, 'm', { stopped: () => false, generate: async (msg) => { messages.push(msg); return messages.length === 3 ? { content: 'ok', responseMessages: [call] } : { content: 'x', responseMessages: [skip] }; } });
    expect(out.status).toBe('ok');
    expect(out.attempts).toBe(3);
    expect(messages[1]).toBe(verifiedChatRetryMessage(['create_blog_article']));
    expect(missingRequiredTools(['a', 'b'], [{ name: 'a' }])).toEqual(['b']);
  });

  it('stops after the maximum attempts and leaves the failure to runFailure', async () => {
    let n = 0;
    const out = await runVerified(t, 'm', { stopped: () => false, generate: async () => { n++; return { content: 'x', responseMessages: [skip] }; } });
    expect(n).toBe(VERIFIED_CHAT_MAX_ATTEMPTS);
    expect(runFailure({ ...run({ taskType: 'report', model: 'm' }), ...out }, t)).toMatch(/required tool not called/);
  });

  it('a task with no required tool is one turn; a non-transient error ends the run', async () => {
    let n = 0;
    await runVerified(task({ requiredTools: [] }), 'm', { stopped: () => false, generate: async () => { n++; return { content: 'x', responseMessages: [skip] }; } });
    expect(n).toBe(1);
    const failed = await runVerified(t, 'm', { stopped: () => false, generate: async () => { throw new Error('bad request'); } });
    expect(failed).toMatchObject({ status: 'error', error: 'bad request' });
  });
});

describe('budget', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'router-ab-budget-'));
    file = path.join(dir, 'budget.jsonl');
    BudgetLedger.init(file, { generationUsd: 1, judgeUsd: 1 });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const costOf = (res: { cost?: number }) => res.cost;

  it('is shared: a second ledger on the same file sees the first one\'s spend, and only one holds it at a time', () => {
    const a = BudgetLedger.open(file);
    a.settle(a.reserve('generation', 0.6, 'x', 'run1'), 0.6, 'reported');
    expect(() => BudgetLedger.open(file)).toThrow(/another run holds/);
    a.close();
    const b = BudgetLedger.open(file);
    expect(b.spent('generation')).toBeCloseTo(0.6);
    expect(() => b.reserve('generation', 0.5, 'y', 'run2')).toThrow(BudgetExceededError);
    b.close();
  });

  it('charges an unsettled reservation in full (a crash only over-counts) and refuses a second init', () => {
    const a = BudgetLedger.open(file);
    a.reserve('judge', 0.7, 'x', 'o');
    a.close();
    const b = BudgetLedger.open(file);
    expect(b.spent('judge')).toBeCloseTo(0.7);
    b.close();
    expect(() => BudgetLedger.init(file, { generationUsd: 5, judgeUsd: 5 })).toThrow();
  });

  it('reserves max(upper bound, largest seen), settles at the reported cost and counts every call in scope', async () => {
    const ledger = BudgetLedger.open(file);
    const meter = new CostMeter(ledger, 'generation', 'o', costOf);
    const { calls } = await meter.scoped('t', async () => {
      await meter.meter('m', 0.1, async () => ({ cost: 0.3 }));
      await meter.meter('m', 0.1, async () => ({ cost: 0.05 }), 'suggested_replies');
    });
    expect(reportedCostUsd(calls)).toBeCloseTo(0.35);
    expect(calls[1].feature).toBe('suggested_replies');
    expect(ledger.spent('generation')).toBeCloseTo(0.35);
    // the next call reserves the largest seen (0.3), not the 0.1 estimate
    await expect(meter.meter('m', 0.1, async () => ({ cost: 0.01 }))).resolves.toBeDefined();
    await expect(meter.meter('m', 0.1, async () => ({ cost: 0.01 }))).resolves.toBeDefined();
    expect(ledger.spent('generation')).toBeCloseTo(0.37);
    await expect(meter.meter('m', 0.7, async () => { throw new Error('never sent'); })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(meter.fatal).toBeInstanceOf(BudgetExceededError);
    ledger.close();
  });

  it('stops the run when a call reports no cost, charging its reservation', async () => {
    const ledger = BudgetLedger.open(file);
    const meter = new CostMeter(ledger, 'generation', 'o', costOf);
    const { error, calls } = await meter.scoped('t', () => meter.meter('m', 0.2, async () => ({})));
    expect(error).toMatchObject({ code: 'ROUTER_AB_COST_UNREPORTED' });
    expect(calls[0]).toMatchObject({ outcome: 'unreported', costUsd: 0.2 });
    expect(reportedCostUsd(calls)).toBe(0);
    expect(ledger.spent('generation')).toBeCloseTo(0.2);
    await expect(meter.meter('m', 0.01, async () => ({ cost: 0 }))).rejects.toBe(meter.fatal);
    ledger.close();
  });

  it('upper bound counts every character as a third of a token with the full output allowance', () => {
    const m = Object.keys(MODEL_PRICING)[0];
    expect(callUpperBoundUsd(m, 3_000_000, 0)).toBeCloseTo(MODEL_PRICING[m].inPerM);
  });

  it('tolerates a truncated last JSONL line (and trims it), but not corruption elsewhere', () => {
    const f = path.join(dir, 'runs.jsonl');
    writeFileSync(f, '{"a":1}\n{"a":2');
    expect(readJsonlRepairing(f, () => undefined)).toEqual([{ a: 1 }]);
    expect(readFile(f, 'utf8')).toBe('{"a":1}\n');
    appendFileSync(f, '{"a":3}\n');
    expect(readJsonlRepairing(f)).toEqual([{ a: 1 }, { a: 3 }]);
    writeFileSync(f, '{"a":1}\nnot json\n{"a":3}\n');
    expect(() => readJsonlRepairing(f)).toThrow(/line 2/);
    expect(existsSync(f)).toBe(true);
  });

  it('re-pricing keeps the observed side-call cost and moves only the arm model\'s token price', () => {
    const m = 'gemini-3.8-flash';
    const r = run({ model: m, usage: [{ promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }], costUsd: 1 });
    const base = MODEL_PRICING[m].inPerM;
    expect(repricedCostUsd(r, { ...MODEL_PRICING[m], inPerM: base + 1 })).toBeCloseTo(2);
  });
});
