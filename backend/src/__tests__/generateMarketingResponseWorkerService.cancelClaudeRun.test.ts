/**
 * ENG-2113: every Stop / generation-timeout / auto-continuation-preemption site already calls
 * `generateMarketingResponseWorkerService.cancelSession(sessionId)`. A turn on the user's own Claude plan
 * runs in the main process, so that call must also reach the Claude run registry, and must change nothing
 * for a session that has no Claude turn.
 */
import { GenerateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { ClaudeRunRegistry, claudeRunRegistry } from '../services/funding/claudeRunRegistry';

jest.mock('child_process', () => ({ fork: jest.fn() }));

describe('cancelSession reaches a running Claude turn', () => {
  const service = new GenerateMarketingResponseWorkerService();
  const registered: Array<{ release(): void }> = [];

  afterEach(() => {
    registered.splice(0).forEach((h) => h.release());
  });

  it('stops the Claude turn of that session: refuse new calls, then abort', () => {
    const order: string[] = [];
    registered.push(claudeRunRegistry.register('s-claude', 'u1', 'c1', { refuseNewCalls: () => void order.push('refuse'), abort: () => void order.push('abort') }));
    service.cancelSession('s-claude');
    expect(order).toEqual(['refuse', 'abort']);
  });

  it('leaves a different session\'s Claude turn alone', () => {
    const abort = jest.fn();
    registered.push(claudeRunRegistry.register('s-other', 'u2', 'c2', { refuseNewCalls: jest.fn(), abort }));
    service.cancelSession('s-claude');
    expect(abort).not.toHaveBeenCalled();
  });

  describe('shutdown drain', () => {
    it('waits for a running Claude turn before it finishes, like it waits for worker requests', async () => {
      let released = false;
      const handle = claudeRunRegistry.register('s-drain', 'u1', 'c1', { refuseNewCalls: jest.fn(), abort: jest.fn() });
      registered.push(handle);
      setTimeout(() => {
        released = true;
        handle.release();
      }, 80);
      await service.shutdown(3_000);
      expect(released).toBe(true);
    });

    it('stops the Claude turns that outlast the ceiling, so the host turns are interrupted before the process exits', async () => {
      const abort = jest.fn();
      const refuse = jest.fn();
      registered.push(claudeRunRegistry.register('s-stuck', 'u1', 'c1', { refuseNewCalls: refuse, abort }));
      await service.shutdown(60);
      expect(refuse).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it('does not wait when no Claude turn is running', async () => {
      const t0 = Date.now();
      await service.shutdown(5_000);
      expect(Date.now() - t0).toBeLessThan(1_000);
    });
  });

  it('is a no-op for a session with no Claude turn (Emma, as today): nothing forked, nothing thrown', () => {
    expect(() => service.cancelSession('s-emma')).not.toThrow();
    expect(claudeRunRegistry).toBeInstanceOf(ClaudeRunRegistry);
    expect(claudeRunRegistry.size).toBe(0);
  });
});
