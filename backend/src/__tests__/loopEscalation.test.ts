import { LoopEscalationService, EscalationEvent } from '../services/loopEscalation';

describe('LoopEscalationService', () => {
  let service: LoopEscalationService;
  let escalations: EscalationEvent[];

  beforeEach(() => {
    escalations = [];
    service = new LoopEscalationService({
      onEscalate: async (event) => {
        escalations.push(event);
      },
    });
  });

  // FAIL test 1: Missing loop info throws
  it('should throw when loopId is missing', async () => {
    await expect(
      service.escalate({
        loopId: '',
        loopName: 'Test Loop',
        error: 'Something failed',
        runId: 'run-123',
      }),
    ).rejects.toThrow('loopId is required');
  });

  // FAIL test 2: Missing error message throws
  it('should throw when error message is empty', async () => {
    await expect(
      service.escalate({
        loopId: 'test-loop',
        loopName: 'Test Loop',
        error: '',
        runId: 'run-123',
      }),
    ).rejects.toThrow('error is required');
  });

  // FAIL test 3: Callback failure is caught and re-thrown
  it('should propagate callback errors', async () => {
    const failingService = new LoopEscalationService({
      onEscalate: async () => {
        throw new Error('Notion API down');
      },
    });

    await expect(
      failingService.escalate({
        loopId: 'test-loop',
        loopName: 'Test Loop',
        error: 'Execution timeout',
        runId: 'run-456',
      }),
    ).rejects.toThrow('Notion API down');
  });

  // SUCCESS test 4: Creates escalation with correct fields
  it('should create escalation event with correct priority and details', async () => {
    await service.escalate({
      loopId: 'sprint-worker',
      loopName: 'Sprint Worker',
      error: 'Claude CLI exited with code 1: TypeError at line 42',
      runId: 'run-789',
    });

    expect(escalations).toHaveLength(1);
    const event = escalations[0];
    expect(event.loopId).toBe('sprint-worker');
    expect(event.loopName).toBe('Sprint Worker');
    expect(event.error).toContain('TypeError at line 42');
    expect(event.priority).toBe('High');
    expect(event.title).toContain('Sprint Worker');
    expect(event.title).toContain('failed');
    expect(event.createdAt).toBeDefined();
  });

  // SUCCESS test 5: Consecutive failures increase priority
  it('should escalate to Critical priority after 3 consecutive failures', async () => {
    for (let i = 0; i < 3; i++) {
      await service.escalate({
        loopId: 'campaign-watchdog',
        loopName: 'Campaign Watchdog',
        error: `Failure #${i + 1}`,
        runId: `run-${i}`,
      });
    }

    expect(escalations).toHaveLength(3);
    expect(escalations[0].priority).toBe('High');
    expect(escalations[1].priority).toBe('High');
    expect(escalations[2].priority).toBe('Critical');
  });

  // SUCCESS test 6: Reset failure count on success
  it('should reset failure counter when reportSuccess is called', async () => {
    // Two failures
    await service.escalate({
      loopId: 'test-loop',
      loopName: 'Test',
      error: 'fail 1',
      runId: 'r1',
    });
    await service.escalate({
      loopId: 'test-loop',
      loopName: 'Test',
      error: 'fail 2',
      runId: 'r2',
    });

    // Report success
    service.reportSuccess('test-loop');

    // Next failure should be High again, not Critical
    await service.escalate({
      loopId: 'test-loop',
      loopName: 'Test',
      error: 'fail 3',
      runId: 'r3',
    });

    expect(escalations[2].priority).toBe('High');
  });
});
