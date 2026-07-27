/**
 * Unit tests for createInstanceRunner (core/instanceRunner.ts) — the shared
 * register/run choreography extracted from the four loop instance modules.
 * Pins the branches the instance-level tests reach only indirectly:
 * env gating, idempotent registration, custom already-registered checks,
 * registerOnRun:false, and mutation handoff.
 */

import { _resetRegistryForTesting, getRegisteredLoopIds, getSensor } from '../loops';
import {
  createInstanceRunner,
  type InstanceLayers,
  type InstanceRunnerConfig,
} from '../loops/core/instanceRunner';
import { runLoop } from '../loops/core/orchestrator';
import type { LoopPorts } from '../loops/core/ports';
import type { LoopManifest, LoopRunResult } from '../loops/core/types';

jest.mock('../loops/core/orchestrator', () => ({
  runLoop: jest.fn(),
}));

const mockedRunLoop = runLoop as jest.MockedFunction<typeof runLoop>;

const LOOP_ID = 'runner-test-loop';

function manifest(over: Partial<LoopManifest> = {}): LoopManifest {
  return {
    loopId: LOOP_ID,
    sensorImpl: 'runnerTestSensor',
    rulesetImpl: 'runnerTestRules',
    toolsImpl: 'runnerTestTools',
    learningImpl: 'runnerTestLearning',
    approval: { slackUserId: 'U_TEST' },
    ...over,
  } as unknown as LoopManifest;
}

function fakeResult(over: Partial<LoopRunResult> = {}): LoopRunResult {
  return { runId: 'run_runner', eventsScanned: 3, proposals: [], mutations: [], ...over } as unknown as LoopRunResult;
}

function fakePorts(): LoopPorts {
  return {
    s3: {},
    dynamo: {},
    bedrock: {},
    slack: { postMessage: jest.fn() },
    clock: { now: () => new Date() },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as unknown as LoopPorts;
}

function config(over: Partial<InstanceRunnerConfig> = {}): InstanceRunnerConfig {
  return {
    loopId: LOOP_ID,
    ports: fakePorts,
    implNames: {
      sensor: 'runnerTestSensor',
      ruleSet: 'runnerTestRules',
      tools: 'runnerTestTools',
      learning: 'runnerTestLearning',
    },
    buildLayers: () => ({
      sensor: { fetchEvents: jest.fn().mockResolvedValue([]) },
      ruleSet: { evaluate: jest.fn().mockResolvedValue([]) },
      tools: { apply: jest.fn() },
      learning: {
        recordDecision: jest.fn(),
        recordOutcome: jest.fn(),
        getHistory: jest.fn().mockResolvedValue([]),
      } as unknown as InstanceLayers['learning'],
    }),
    manifest: () => manifest(),
    onRunComplete: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('createInstanceRunner', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
    mockedRunLoop.mockResolvedValue(fakeResult());
  });

  afterEach(() => {
    _resetRegistryForTesting();
  });

  it('register() wires all four layers + the manifest', () => {
    const runner = createInstanceRunner(config());

    expect(runner.layers).toBeNull();
    expect(runner.register()).toBe(true);

    expect(getRegisteredLoopIds() as readonly string[]).toContain(LOOP_ID);
    expect(getSensor('runnerTestSensor')).toBeDefined();
    expect(runner.layers?.learning).toBeDefined();
  });

  it('register() is idempotent — second call does not rebuild the layers', () => {
    const buildLayers = jest.fn(config().buildLayers);
    const runner = createInstanceRunner(config({ buildLayers }));

    expect(runner.register()).toBe(true);
    expect(runner.register()).toBe(true);
    expect(buildLayers).toHaveBeenCalledTimes(1);
  });

  it('register() returns false and registers nothing when env-gated off', () => {
    const runner = createInstanceRunner(config({ isEnabled: () => false }));

    expect(runner.register()).toBe(false);
    expect(getRegisteredLoopIds() as readonly string[]).not.toContain(LOOP_ID);
  });

  it('runOnce() returns null without running the loop when env-gated off', async () => {
    const onRunComplete = jest.fn();
    const runner = createInstanceRunner(config({ isEnabled: () => false, onRunComplete }));

    await expect(runner.runOnce()).resolves.toBeNull();
    expect(mockedRunLoop).not.toHaveBeenCalled();
    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it('runOnce() registers, runs, and hands mutations to onRunComplete', async () => {
    const onRunComplete = jest.fn().mockResolvedValue(undefined);
    const runner = createInstanceRunner(config({ onRunComplete }));

    const result = await runner.runOnce();

    expect(result).toEqual(fakeResult());
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith(
      expect.objectContaining({ result: fakeResult(), mutations: [], manifest: expect.objectContaining({ loopId: LOOP_ID }) }),
    );
  });

  it('runOnce() passes the orchestrator mutations without a second collector', async () => {
    const onRunComplete = jest.fn().mockResolvedValue(undefined);
    const runner = createInstanceRunner(config({ onRunComplete }));
    const produced = [{ mutationId: 'm1', proposalId: 'p1', kind: 'copy', artifact: {} }];
    mockedRunLoop.mockResolvedValue(fakeResult({ mutations: produced as never }));

    await runner.runOnce();

    expect(onRunComplete.mock.calls[0][0].mutations).toEqual(produced);
  });

  it('runOnce() with registerOnRun:false skips registration entirely', async () => {
    const other = createInstanceRunner(config());
    other.register();
    const buildLayers = jest.fn(config().buildLayers);
    const runner = createInstanceRunner(config({ registerOnRun: false, buildLayers }));

    await runner.runOnce();

    expect(buildLayers).not.toHaveBeenCalled();
  });

  it('honors a custom isAlreadyRegistered check (re-registers when it says no)', () => {
    const buildLayers = jest.fn(config().buildLayers);
    let already = false;
    const runner = createInstanceRunner(config({ buildLayers, isAlreadyRegistered: () => already }));

    expect(runner.register()).toBe(true);
    already = true;
    expect(runner.register()).toBe(true);
    already = false;
    expect(runner.register()).toBe(true); // replaces wiring via registerOrReplace*

    expect(buildLayers).toHaveBeenCalledTimes(2);
  });

  it('resetForTesting() drops the held layers', () => {
    const runner = createInstanceRunner(config());
    runner.register();
    expect(runner.layers).not.toBeNull();

    runner.resetForTesting();

    expect(runner.layers).toBeNull();
  });
});
