import {
  OPENROUTER_MIGRATION_BASELINES,
  validateOpenRouterMigrationBaselines,
} from '../loops/eval/openRouterMigrationBaselines';

describe('OpenRouter migration baselines (ENG-1423)', () => {
  it('covers every migration task class before Slice B can move traffic', () => {
    expect(OPENROUTER_MIGRATION_BASELINES.map((baseline) => baseline.taskClass).sort()).toEqual([
      'agent_engine',
      'coding_agent',
      'content_generation',
      'interactive_agent_mode',
      'mcp',
      'scheduled_chat',
    ]);
  });

  it('gives every task class a safe executable fixture and its behavior contract', () => {
    for (const baseline of OPENROUTER_MIGRATION_BASELINES) {
      expect(baseline.fixture.id).toMatch(/^openrouter-baseline-/);
      expect(baseline.fixture.representativeInput.length).toBeGreaterThan(0);
      expect(baseline.fixture.behaviorContract.length).toBeGreaterThan(0);
    }
  });

  it('records the model, capabilities, token mix, cost, latency, and current failure semantics', () => {
    expect(validateOpenRouterMigrationBaselines(OPENROUTER_MIGRATION_BASELINES)).toEqual([]);
  });

  it('rejects a baseline that silently omits a required evidence field', () => {
    const [first] = OPENROUTER_MIGRATION_BASELINES;
    expect(validateOpenRouterMigrationBaselines([{ ...first, latency: undefined }])).toEqual([
      'interactive_agent_mode: latency is required',
    ]);
  });
});
