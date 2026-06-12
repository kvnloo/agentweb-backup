/**
 * Unit tests for createInstanceRunner (core/instanceRunner.ts) — the shared
 * register/run choreography extracted from the four loop instance modules.
 * Pins the branches the instance-level tests reach only indirectly:
 * env gating, idempotent registration, custom already-registered checks,
 * registerOnRun:false, and gate draining.
 */

import { _resetRegistryForTesting, getRegisteredLoopIds, getSensor } from '../loops';
import { CaptureGate } from '../loops/core/gates/captureGate';
import {
  createInstanceRunner,
  type InstanceLayers,
  type InstanceRunnerConfig,
} from '../loops/core/instanceRunner';
import { runLoop } from '../loops/core/orchestrator';
import type { LoopPorts } from '../loops/core/ports';
import type { LoopManifest, LoopRunResult, Mutation } from '../loops/core/types';
import { asMutationId } from '../loops/core/types';

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
    gateImpl: 'runnerTestGate',
    learningImpl: 'runnerTestLearning',
    approval: { slackUserId: 'U_TEST' },
    ...over,
  } as unknown as LoopManifest;
}

function fakeResult(over: Partial<LoopRunResult> = {}): LoopRunResult {
  return { runId: 'run_runner', eventsScanned: 3, proposals: [], ...over } as unknown as LoopRunResult;
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
      gate: 'runnerTestGate',
      learning: 'runnerTestLearning',
    },
    buildLayers: () => ({
      sensor: { fetchEvents: jest.fn().mockResolvedValue([]) },
      ruleSet: { evaluate: jest.fn().mockResolvedValue([]) },
      tools: { apply: jest.fn() },
      gate: new CaptureGate(),
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

  it('register() wires all five layers + the manifest and holds the gate', () => {
    const runner = createInstanceRunner(config());

    expect(runner.gate).toBeNull();
    expect(runner.layers).toBeNull();
    expect(runner.register()).toBe(true);

    expect(getRegisteredLoopIds() as readonly string[]).toContain(LOOP_ID);
    expect(getSensor('runnerTestSensor')).toBeDefined();
    expect(runner.gate).toBeInstanceOf(CaptureGate);
    expect(runner.layers?.gate).toBe(runner.gate);
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

  it('runOnce() registers, runs, drains the gate, and hands everything to onRunComplete', async () => {
    const onRunComplete = jest.fn().mockResolvedValue(undefined);
    const runner = createInstanceRunner(config({ onRunComplete }));

    const result = await runner.runOnce();

    expect(result).toEqual(fakeResult());
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith(
      expect.objectContaining({ result: fakeResult(), drained: [], manifest: expect.objectContaining({ loopId: LOOP_ID }) }),
    );
  });

  it('runOnce() drains the mutations the gate captured during the run', async () => {
    const onRunComplete = jest.fn().mockResolvedValue(undefined);
    const runner = createInstanceRunner(config({ onRunComplete }));
    runner.register();
    const captured = {
      mutationId: asMutationId('m1'),
      proposalId: asMutationId('p1'),
      kind: 'copy',
      artifact: {},
    } as unknown as Mutation;
    await runner.gate!.requestApproval(captured);

    await runner.runOnce();

    expect(onRunComplete.mock.calls[0][0].drained).toEqual([captured]);
    expect(runner.gate!.captured).toHaveLength(0); // drained, not copied
  });

  it('runOnce() passes drained:null when no gate is held (registerOnRun:false, app-boot wiring missing)', async () => {
    // Another module registered the manifest, but THIS runner never did — so
    // it holds no gate, mirroring the pre-refactor module-singleton behavior.
    const other = createInstanceRunner(config());
    other.register();
    const onRunComplete = jest.fn().mockResolvedValue(undefined);
    const runner = createInstanceRunner(config({ registerOnRun: false, onRunComplete }));

    await runner.runOnce();

    expect(onRunComplete.mock.calls[0][0].drained).toBeNull();
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

  it('resetForTesting() drops the held gate and layers', () => {
    const runner = createInstanceRunner(config());
    runner.register();
    expect(runner.gate).not.toBeNull();

    runner.resetForTesting();

    expect(runner.gate).toBeNull();
    expect(runner.layers).toBeNull();
  });
});
