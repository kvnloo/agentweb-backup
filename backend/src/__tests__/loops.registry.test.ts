/**
 * Tests for the LOOP_REGISTRY at backend/src/loops/index.ts.
 *
 * Covers the lifecycle of registering + retrieving the 5 layer implementations
 * and loop manifests, including duplicate-registration and missing-impl error
 * paths. The registry is the only runtime logic shipped in Phase 1a — the
 * rest of `loops/` is type definitions + injected ports.
 */

import {
  ApprovalGate,
  EventSource,
  LearningStore,
  LoopManifest,
  MutationTools,
  NormalizedEvent,
  RuleSet,
  asLoopId,
} from '../loops/core/types';
import {
  _resetRegistryForTesting,
  getGate,
  getLearningStore,
  getLoopManifest,
  getRegisteredLoopIds,
  getRuleSet,
  getSensor,
  getTools,
  registerGate,
  registerLearningStore,
  registerLoop,
  registerRuleSet,
  registerSensor,
  registerTools,
} from '../loops';

// ---------------------------------------------------------------------------
// Stub implementations — each layer needs a minimal impl for registration.
// These exist only to satisfy the interface; they never run.
// ---------------------------------------------------------------------------

const stubSensor: EventSource<NormalizedEvent> = {
  fetchEvents: jest.fn().mockResolvedValue([]),
};

const stubRuleSet: RuleSet<NormalizedEvent, unknown> = {
  evaluate: jest.fn().mockResolvedValue([]),
};

const stubTools: MutationTools<unknown> = {
  apply: jest.fn(),
};

const stubGate: ApprovalGate = {
  requestApproval: jest.fn(),
  pollDecision: jest.fn(),
};

const stubLearning: LearningStore = {
  record: jest.fn().mockResolvedValue(undefined),
  queryHistory: jest.fn().mockResolvedValue([]),
};

const stubManifest: LoopManifest = {
  loopId: asLoopId('test-loop'),
  displayName: 'Test Loop',
  paused: false,
  targetMetric: {
    name: 'test_rate',
    numeratorEvent: 'completed',
    denominatorEvent: 'started',
    windowDays: 7,
  },
  allowedEventTypes: ['started', 'completed'],
  mutationSurface: [{ key: 'headline', kind: 'copy' }],
  sensorImpl: 'stubSensor',
  rulesetImpl: 'stubRuleSet',
  toolsImpl: 'stubTools',
  gateImpl: 'stubGate',
  learningImpl: 'stubLearning',
  thresholds: {
    promoteLiftPct: 15,
    promoteMinNPerArm: 80,
    retireLiftPct: -10,
    retireMinNPerArm: 50,
    watchdogRollbackPct24h: 20,
    watchdogPausePct7d: 10,
    maxActiveArmsPerKey: 5,
    maxTokensPerCycleUsd: 5,
  },
  generator: {
    candidatesPerCycle: 30,
    model: 'claude-sonnet-4-6',
    systemPrompt: 'test',
  },
  critic: {
    model: 'claude-sonnet-4-6',
    rubric: ['clarity'],
    minScore: 0.7,
  },
  approval: {
    dmTitleTemplate: 'Test Loop — {date}',
  },
  businessRules: [],
};

beforeEach(() => {
  _resetRegistryForTesting();
});

describe('loops registry — failure paths (TDD fail cases)', () => {
  it('throws when registering the same sensor name twice', () => {
    registerSensor('s', stubSensor);
    expect(() => registerSensor('s', stubSensor)).toThrow(/sensor impl already registered/);
  });

  it('throws when registering the same ruleset name twice', () => {
    registerRuleSet('r', stubRuleSet);
    expect(() => registerRuleSet('r', stubRuleSet)).toThrow(/ruleset impl already registered/);
  });

  it('throws when registering the same tools name twice', () => {
    registerTools('t', stubTools);
    expect(() => registerTools('t', stubTools)).toThrow(/tools impl already registered/);
  });

  it('throws when registering the same gate name twice', () => {
    registerGate('g', stubGate);
    expect(() => registerGate('g', stubGate)).toThrow(/gate impl already registered/);
  });

  it('throws when registering the same learning store name twice', () => {
    registerLearningStore('l', stubLearning);
    expect(() => registerLearningStore('l', stubLearning)).toThrow(/learning impl already registered/);
  });

  it('throws when registering the same loop twice', () => {
    registerLoop(stubManifest);
    expect(() => registerLoop(stubManifest)).toThrow(/loop already registered/);
  });

  it('throws when getting an unregistered sensor', () => {
    expect(() => getSensor('missing')).toThrow(/sensor impl not registered/);
  });

  it('throws when getting an unregistered ruleset', () => {
    expect(() => getRuleSet('missing')).toThrow(/ruleset impl not registered/);
  });

  it('throws when getting an unregistered tools impl', () => {
    expect(() => getTools('missing')).toThrow(/tools impl not registered/);
  });

  it('throws when getting an unregistered gate', () => {
    expect(() => getGate('missing')).toThrow(/gate impl not registered/);
  });

  it('throws when getting an unregistered learning store', () => {
    expect(() => getLearningStore('missing')).toThrow(/learning impl not registered/);
  });

  it('throws when getting an unregistered loop', () => {
    expect(() => getLoopManifest(asLoopId('missing'))).toThrow(/loop not registered/);
  });
});

describe('loops registry — happy paths', () => {
  it('register + get round-trips for every layer', () => {
    registerSensor('s', stubSensor);
    registerRuleSet('r', stubRuleSet);
    registerTools('t', stubTools);
    registerGate('g', stubGate);
    registerLearningStore('l', stubLearning);

    expect(getSensor('s')).toBe(stubSensor);
    expect(getRuleSet('r')).toBe(stubRuleSet);
    expect(getTools('t')).toBe(stubTools);
    expect(getGate('g')).toBe(stubGate);
    expect(getLearningStore('l')).toBe(stubLearning);
  });

  it('registerLoop + getLoopManifest round-trips', () => {
    registerLoop(stubManifest);
    expect(getLoopManifest(asLoopId('test-loop'))).toBe(stubManifest);
  });

  it('getRegisteredLoopIds returns all registered loops', () => {
    expect(getRegisteredLoopIds()).toEqual([]);
    registerLoop(stubManifest);
    expect(getRegisteredLoopIds()).toEqual([asLoopId('test-loop')]);

    const second: LoopManifest = { ...stubManifest, loopId: asLoopId('test-loop-2') };
    registerLoop(second);
    expect(getRegisteredLoopIds()).toHaveLength(2);
    expect(getRegisteredLoopIds()).toContain(asLoopId('test-loop'));
    expect(getRegisteredLoopIds()).toContain(asLoopId('test-loop-2'));
  });

  it('different implementations can register under different names', () => {
    registerSensor('userArray', stubSensor);
    registerSensor('eventTable', stubSensor);
    expect(getSensor('userArray')).toBe(stubSensor);
    expect(getSensor('eventTable')).toBe(stubSensor);
  });

  it('_resetRegistryForTesting clears every registry slot', () => {
    registerSensor('s', stubSensor);
    registerRuleSet('r', stubRuleSet);
    registerTools('t', stubTools);
    registerGate('g', stubGate);
    registerLearningStore('l', stubLearning);
    registerLoop(stubManifest);

    _resetRegistryForTesting();

    expect(() => getSensor('s')).toThrow();
    expect(() => getRuleSet('r')).toThrow();
    expect(() => getTools('t')).toThrow();
    expect(() => getGate('g')).toThrow();
    expect(() => getLearningStore('l')).toThrow();
    expect(() => getLoopManifest(asLoopId('test-loop'))).toThrow();
    expect(getRegisteredLoopIds()).toEqual([]);
  });
});
