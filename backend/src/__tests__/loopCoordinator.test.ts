// Tests for Loop Coordinator Service — Phase 1

import { LoopCoordinatorService, LoopDefinition } from '../services/loopCoordinatorService';

// Mock db module
const mockCreateLoopRun = jest.fn();
const mockUpdateLoopRun = jest.fn();
const mockGetLoopRuns = jest.fn();
jest.mock('../services/db', () => ({
  loopDb: {
    createLoopRun: (...args: any[]) => mockCreateLoopRun(...args),
    updateLoopRun: (...args: any[]) => mockUpdateLoopRun(...args),
    getLoopRuns: (...args: any[]) => mockGetLoopRuns(...args),
  },
}));

describe('LoopCoordinatorService', () => {
  let coordinator: LoopCoordinatorService;

  const sampleLoop: LoopDefinition = {
    id: 'test-loop',
    name: 'Test Loop',
    intervalMs: 100, // 100ms for fast tests
    executor: jest.fn().mockResolvedValue({ result: 'done' }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    coordinator = new LoopCoordinatorService();
    mockCreateLoopRun.mockResolvedValue(undefined);
    mockUpdateLoopRun.mockResolvedValue(undefined);
    mockGetLoopRuns.mockResolvedValue([]);
  });

  afterEach(async () => {
    await coordinator.shutdown();
  });

  // ---- FAILURE TESTS ----

  it('should throw when registering a loop with duplicate id', () => {
    coordinator.registerLoop(sampleLoop);
    expect(() => coordinator.registerLoop(sampleLoop)).toThrow('already registered');
  });

  it('should throw when starting a loop that is not registered', async () => {
    await expect(coordinator.startLoop('nonexistent')).rejects.toThrow('not registered');
  });

  it('should throw when starting a loop that is already running', async () => {
    coordinator.registerLoop(sampleLoop);
    await coordinator.startLoop('test-loop');
    await expect(coordinator.startLoop('test-loop')).rejects.toThrow('already running');
  });

  it('should throw when stopping a loop that is not running', async () => {
    coordinator.registerLoop(sampleLoop);
    await expect(coordinator.stopLoop('test-loop')).rejects.toThrow('not running');
  });

  // ---- SUCCESS TESTS ----

  it('should register a loop and show it in status', () => {
    coordinator.registerLoop(sampleLoop);
    const status = coordinator.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].id).toBe('test-loop');
    expect(status[0].running).toBe(false);
  });

  it('should start a loop and execute it', async () => {
    coordinator.registerLoop(sampleLoop);
    await coordinator.startLoop('test-loop');

    const status = coordinator.getStatus();
    expect(status[0].running).toBe(true);

    // Wait for at least one execution
    await new Promise((r) => setTimeout(r, 200));

    expect(sampleLoop.executor).toHaveBeenCalled();
    expect(mockCreateLoopRun).toHaveBeenCalled();
  });

  it('should stop a running loop', async () => {
    coordinator.registerLoop(sampleLoop);
    await coordinator.startLoop('test-loop');

    const statusBefore = coordinator.getStatus();
    expect(statusBefore[0].running).toBe(true);

    await coordinator.stopLoop('test-loop');

    const statusAfter = coordinator.getStatus();
    expect(statusAfter[0].running).toBe(false);
  });

  it('should record failed executions in loop runs', async () => {
    const failingLoop: LoopDefinition = {
      id: 'fail-loop',
      name: 'Failing Loop',
      intervalMs: 100,
      executor: jest.fn().mockRejectedValue(new Error('executor crashed')),
    };

    coordinator.registerLoop(failingLoop);
    await coordinator.startLoop('fail-loop');

    await new Promise((r) => setTimeout(r, 200));

    // Should have called updateLoopRun with error status
    expect(mockUpdateLoopRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('executor crashed'),
      })
    );

    await coordinator.stopLoop('fail-loop');
  });

  it('should shutdown all running loops', async () => {
    const loop2: LoopDefinition = {
      id: 'loop-2',
      name: 'Loop 2',
      intervalMs: 100,
      executor: jest.fn().mockResolvedValue({}),
    };

    coordinator.registerLoop(sampleLoop);
    coordinator.registerLoop(loop2);
    await coordinator.startLoop('test-loop');
    await coordinator.startLoop('loop-2');

    await coordinator.shutdown();

    const status = coordinator.getStatus();
    expect(status.every((s) => !s.running)).toBe(true);
  });
});
