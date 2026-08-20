/**
 * ENG-1423 — the immutable baseline contract for the OpenRouter migration.
 *
 * These entries deliberately describe what must be compared, rather than
 * inventing a quality score.  Cost/token evidence comes from AW-UsageRecords;
 * an explicit telemetry gap remains a failed readiness condition, never a
 * zero-valued latency or an implied output-equivalence claim.
 */

export type OpenRouterMigrationTaskClass =
  | 'interactive_agent_mode'
  | 'scheduled_chat'
  | 'content_generation'
  | 'mcp'
  | 'agent_engine'
  | 'coding_agent';

export interface OpenRouterMigrationBaseline {
  taskClass: OpenRouterMigrationTaskClass;
  fixture: {
    id: string;
    representativeInput: string;
    behaviorContract: string;
  };
  incumbentLogicalModel: string;
  requirements: { streaming: boolean; tools: boolean; structuredOutput: boolean };
  tokenMix: { input: number; output: number; cacheRead: number; cacheWrite: number };
  recordedCostMicroUsd: number;
  latency: { status: 'recorded' | 'not_recorded'; detail: string };
  failureSemantics: string;
  evaluator: { kind: 'executable_fixture'; command: string };
  evidenceSource: string;
}

const fixture = (taskClass: OpenRouterMigrationTaskClass, representativeInput: string, behaviorContract: string) => ({
  id: `openrouter-baseline-${taskClass}`,
  representativeInput,
  behaviorContract,
});

/**
 * Read-only AWS ledger snapshot, 2026-08-20.  Values are aggregates by the
 * existing feature key, so they establish the incumbent token/cost mix but do
 * not pretend to be one customer's prompt or a quality claim.
 */
export const OPENROUTER_MIGRATION_BASELINES: readonly OpenRouterMigrationBaseline[] = [
  {
    taskClass: 'interactive_agent_mode',
    fixture: fixture('interactive_agent_mode', 'answer a bounded user question with an allowed tool result', 'returns a final answer and preserves tool/error semantics'),
    incumbentLogicalModel: 'anthropic.claude-opus-5',
    requirements: { streaming: true, tools: true, structuredOutput: false },
    tokenMix: { input: 10_622_712, output: 377_392, cacheRead: 29_976_867, cacheWrite: 9_179_355 },
    recordedCostMicroUsd: 91_527_775,
    latency: { status: 'not_recorded', detail: 'AW-UsageRecords has no latency; Dev-AW-LoopEvents records tool durations but no LLM-turn duration.' },
    failureSemantics: 'terminal run verdict is ok/degraded/failed; tool errors are classified separately',
    evaluator: { kind: 'executable_fixture', command: 'npx jest src/__tests__/openRouterMigrationBaselines.test.ts --runInBand' },
    evidenceSource: 'AW-UsageRecords feature=agent_task:interactive, 2026-08-18 through 2026-08-20',
  },
  {
    taskClass: 'scheduled_chat',
    fixture: fixture('scheduled_chat', 'run one scheduled chat invocation against a deterministic prompt', 'completes one scheduled turn with the selected model and preserves retry semantics'),
    incumbentLogicalModel: 'anthropic.claude-opus-5',
    requirements: { streaming: false, tools: true, structuredOutput: false },
    tokenMix: { input: 358_842, output: 64_353, cacheRead: 9_947_517, cacheWrite: 2_384_563 },
    recordedCostMicroUsd: 23_280_322,
    latency: { status: 'not_recorded', detail: 'The ledger aggregates schedule calls; it has no elapsed-time field.' },
    failureSemantics: 'scheduled execution keeps its existing retry and terminal-status behavior',
    evaluator: { kind: 'executable_fixture', command: 'npx jest src/__tests__/openRouterMigrationBaselines.test.ts --runInBand' },
    evidenceSource: 'AW-UsageRecords feature=agent_task:scheduled:2a00ebe6-242d-4493-9fee-2f7e39197ef1, 2026-08-19 through 2026-08-20',
  },
  {
    taskClass: 'content_generation',
    fixture: fixture('content_generation', 'generate bounded structured marketing content from a fixture', 'returns parseable requested content without changing the existing failure surface'),
    incumbentLogicalModel: 'anthropic.claude-sonnet-4-6',
    requirements: { streaming: true, tools: false, structuredOutput: true },
    tokenMix: { input: 2_332_281, output: 7_005_484, cacheRead: 0, cacheWrite: 0 },
    recordedCostMicroUsd: 85_082_037,
    latency: { status: 'not_recorded', detail: 'The content ledger records aggregate usage and cost, not request latency.' },
    failureSemantics: 'provider errors remain visible to the caller; no output equivalence is assumed',
    evaluator: { kind: 'executable_fixture', command: 'npx jest src/__tests__/openRouterMigrationBaselines.test.ts --runInBand' },
    evidenceSource: 'AW-UsageRecords feature=content_gen, 2026-06-15 through 2026-08-20',
  },
  {
    taskClass: 'mcp',
    fixture: fixture('mcp', 'invoke an MCP-exposed LLM task with a mock tool result', 'returns the declared MCP response shape and preserves typed tool failures'),
    incumbentLogicalModel: 'anthropic.claude-opus-4-8',
    requirements: { streaming: false, tools: true, structuredOutput: true },
    tokenMix: { input: 598_900_729, output: 42_351_193, cacheRead: 3_511_685_114, cacheWrite: 899_081_477 },
    recordedCostMicroUsd: 14_632_635_898,
    latency: { status: 'not_recorded', detail: 'MCP calls currently share the agent_task ledger feature, so no per-MCP latency or cost split exists.' },
    failureSemantics: 'MCP preserves its current typed error response rather than masking provider failures',
    evaluator: { kind: 'executable_fixture', command: 'npx jest src/__tests__/openRouterMigrationBaselines.test.ts --runInBand' },
    evidenceSource: 'AW-UsageRecords feature=agent_task aggregate, 2026-06-14 through 2026-08-20; task-class split absent',
  },
  {
    taskClass: 'agent_engine',
    fixture: fixture('agent_engine', 'run an agent turn with a deterministic tool plan', 'preserves the run verdict and tool-dispatch contract'),
    incumbentLogicalModel: 'anthropic.claude-opus-4-8',
    requirements: { streaming: true, tools: true, structuredOutput: false },
    tokenMix: { input: 598_900_729, output: 42_351_193, cacheRead: 3_511_685_114, cacheWrite: 899_081_477 },
    recordedCostMicroUsd: 14_632_635_898,
    latency: { status: 'not_recorded', detail: 'Run telemetry has verdicts and tool durations, but no model-turn duration or per-run cost.' },
    failureSemantics: 'run verdict remains ok/degraded/failed with classified tool failures',
    evaluator: { kind: 'executable_fixture', command: 'npx jest src/__tests__/openRouterMigrationBaselines.test.ts --runInBand' },
    evidenceSource: 'AW-UsageRecords feature=agent_task aggregate plus Dev-AW-LoopEvents agent-mode verdicts, 2026-08-20',
  },
  {
    taskClass: 'coding_agent',
    fixture: fixture('coding_agent', 'complete a deterministic repository edit fixture', 'returns the existing coding-agent result shape and retains token accounting'),
    incumbentLogicalModel: 'anthropic.claude-sonnet-4-6',
    requirements: { streaming: true, tools: true, structuredOutput: false },
    tokenMix: { input: 5_779_882, output: 89_088, cacheRead: 0, cacheWrite: 0 },
    recordedCostMicroUsd: 18_675_966,
    latency: { status: 'not_recorded', detail: 'Coding-agent ledger rows do not contain elapsed time.' },
    failureSemantics: 'coding-agent provider failures remain errors and do not become a successful result',
    evaluator: { kind: 'executable_fixture', command: 'npx jest src/__tests__/openRouterMigrationBaselines.test.ts --runInBand' },
    evidenceSource: 'AW-UsageRecords feature=coding_agent, 2026-07-30 through 2026-08-20',
  },
];

/** Returns missing-field errors so readiness cannot be inferred from prose. */
export function validateOpenRouterMigrationBaselines(
  baselines: readonly Partial<OpenRouterMigrationBaseline>[],
): string[] {
  const errors: string[] = [];
  for (const baseline of baselines) {
    const taskClass = baseline.taskClass ?? 'unknown';
    if (!baseline.fixture?.id || !baseline.fixture.representativeInput || !baseline.fixture.behaviorContract) errors.push(`${taskClass}: fixture is required`);
    if (!baseline.incumbentLogicalModel) errors.push(`${taskClass}: incumbent model is required`);
    if (!baseline.requirements) errors.push(`${taskClass}: requirements are required`);
    if (!baseline.tokenMix) errors.push(`${taskClass}: token mix is required`);
    if (baseline.recordedCostMicroUsd == null) errors.push(`${taskClass}: recorded cost is required`);
    if (!baseline.latency) errors.push(`${taskClass}: latency is required`);
    if (!baseline.failureSemantics) errors.push(`${taskClass}: failure semantics are required`);
    if (!baseline.evaluator) errors.push(`${taskClass}: executable evaluator is required`);
  }
  return errors;
}
