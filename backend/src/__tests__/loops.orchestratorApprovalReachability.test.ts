import {
  _resetRegistryForTesting,
  registerOrReplaceLearningStore,
  registerOrReplaceRuleSet,
  registerOrReplaceSensor,
  registerOrReplaceTools,
} from '../loops';
import { runLoop } from '../loops/core/orchestrator';
import { InMemoryLearningStore } from '../loops/core/learning/inMemoryLearningStore';
import { recordLoopApproval } from '../loops/core/learning/approvalPersistence';
import {
  asLoopId,
  asMutationId,
  type LoopManifest,
  type Mutation,
  type MutationProposal,
} from '../loops/core/types';
import type { LoopPorts } from '../loops/core/ports';

const LOOP_ID = asLoopId('orchestrator-approval-reachability');
const PROPOSAL_ID = asMutationId('proposal-1');
const MUTATION_ID = asMutationId('mutation-1');
const NOW = new Date('2026-07-27T00:00:00.000Z');

function proposal(): MutationProposal<unknown> {
  return {
    proposalId: PROPOSAL_ID,
    sourceRuleId: 'rule-1',
    hypothesis: 'A deterministic issue should be filed.',
    kind: 'code_change',
    payload: {},
    triggeringStats: {},
  };
}

function mutation(error?: string): Mutation {
  return {
    mutationId: MUTATION_ID,
    proposalId: PROPOSAL_ID,
    kind: 'code_change',
    artifact: { linearIssueId: 'ENG-999' },
    ...(error ? { error } : {}),
  };
}

function manifest(): LoopManifest {
  return {
    loopId: LOOP_ID,
    displayName: 'Orchestrator approval reachability',
    paused: false,
    targetMetric: {
      name: 'completion_rate',
      numeratorEvent: 'completed',
      denominatorEvent: 'started',
      windowDays: 7,
    },
    allowedEventTypes: ['started', 'completed'],
    mutationSurface: [{ key: 'loop', kind: 'code_change' }],
    sensorImpl: 'reachability-sensor',
    rulesetImpl: 'reachability-rules',
    toolsImpl: 'reachability-tools',
    learningImpl: 'reachability-learning',
    thresholds: {
      maxActiveArmsPerKey: 1,
      maxTokensPerCycleUsd: 1,
      promoteMinNPerArm: 1,
    },
    generator: {} as LoopManifest['generator'],
    critic: {} as LoopManifest['critic'],
    approval: {},
    businessRules: [],
  };
}

function ports(): LoopPorts {
  return {
    s3: {} as LoopPorts['s3'],
    dynamo: {} as LoopPorts['dynamo'],
    bedrock: {} as LoopPorts['bedrock'],
    slack: {} as LoopPorts['slack'],
    clock: { now: () => NOW },
    logger: { log: jest.fn() },
  };
}

function register(store: InMemoryLearningStore, produced: Mutation): void {
  registerOrReplaceSensor('reachability-sensor', {
    fetchEvents: jest.fn().mockResolvedValue([]),
  });
  registerOrReplaceRuleSet('reachability-rules', {
    evaluate: jest.fn().mockResolvedValue([proposal()]),
  });
  registerOrReplaceTools('reachability-tools', {
    apply: jest.fn().mockResolvedValue(produced),
  });
  registerOrReplaceLearningStore('reachability-learning', store);
}

describe('orchestrator approval-to-attribution reachability', () => {
  beforeEach(() => _resetRegistryForTesting());
  afterEach(() => _resetRegistryForTesting());

  it('records a successful mutation as pending without reintroducing a gate', async () => {
    const store = new InMemoryLearningStore();
    register(store, mutation());

    await runLoop(manifest(), ports());

    const pending = await store.queryHistory({ loopId: LOOP_ID, status: ['pending'] });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(expect.objectContaining({
      proposal: expect.objectContaining({ proposalId: PROPOSAL_ID }),
      mutation: expect.objectContaining({ mutationId: MUTATION_ID }),
      decision: expect.objectContaining({ status: 'pending' }),
    }));
  });

  it('leaves a pending record that recordLoopApproval can mark shipped', async () => {
    const store = new InMemoryLearningStore();
    register(store, mutation());
    const result = await runLoop(manifest(), ports());

    const approval = await recordLoopApproval({
      runId: result.runId as unknown as string,
      items: [{ id: MUTATION_ID, ok: true }],
      approver: 'slack:harsha',
      stores: [{ loopId: LOOP_ID, store }],
      now: NOW,
    });

    expect(approval).toEqual(expect.objectContaining({ approved: 1, shipped: 1 }));
  });

  it('produces an approved+shipped record eligible for attribution', async () => {
    const store = new InMemoryLearningStore();
    register(store, mutation());
    const result = await runLoop(manifest(), ports());

    await recordLoopApproval({
      runId: result.runId as unknown as string,
      items: [{ id: 'rule-1', ok: true }],
      approver: 'slack:harsha',
      stores: [{ loopId: LOOP_ID, store }],
      now: NOW,
    });

    const eligible = (
      await store.queryHistory({ loopId: LOOP_ID, status: ['approved', 'auto_shipped'] })
    ).filter((record) => record.shippedAt && record.verdict == null);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].proposal?.sourceRuleId).toBe('rule-1');
  });

  it('does not request approval for a failed mutation', async () => {
    const store = new InMemoryLearningStore();
    register(store, mutation('Linear intake failed'));

    await runLoop(manifest(), ports());

    await expect(
      store.queryHistory({ loopId: LOOP_ID, status: ['pending'] }),
    ).resolves.toEqual([]);
  });
});
