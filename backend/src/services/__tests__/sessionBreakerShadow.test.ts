import {
  __resetSessionBreakerShadowForTests,
  readSessionBreakerShadowConfig,
  recordSessionBreakerShadowTurn,
} from '../sessionBreakerShadow';
import { evaluateSessionSpendBreaker } from '../sessionSpendBreaker';

const ON = { SESSION_BREAKER_SHADOW: 'true', SESSION_BREAKER_SHADOW_MAX_TURNS: '40', SESSION_BREAKER_SHADOW_MAX_SPEND_USD: '5' };

describe('sessionBreakerShadow (ENG-2953)', () => {
  beforeEach(() => __resetSessionBreakerShadowForTests());

  it('flag off: evaluator never invoked, cost never computed, nothing logged', () => {
    const evaluate = jest.fn(evaluateSessionSpendBreaker);
    const log = jest.fn();
    const costUsd = jest.fn(() => 100);
    for (const env of [{}, { SESSION_BREAKER_SHADOW: 'false' }, { SESSION_BREAKER_SHADOW: '1' }]) {
      for (let i = 0; i < 100; i++) {
        recordSessionBreakerShadowTurn({ sessionId: 's', isScheduled: false, costUsd }, { env, log, evaluate });
      }
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(costUsd).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(readSessionBreakerShadowConfig({})).toBeNull();
  });

  it('replays the Opiner aea6a0ee shape (549 turns, ~$47): first would-pause at turn 40, one log per multiple', () => {
    const lines: any[] = [];
    const log = (l: string) => lines.push(JSON.parse(l));
    const perTurn = 47 / 549;
    const returned: unknown[] = [];
    for (let t = 1; t <= 549; t++) {
      returned.push(recordSessionBreakerShadowTurn(
        { sessionId: 'aea6a0ee', userId: 'u1', billingUserId: 'b1', isScheduled: false, costUsd: () => perTurn },
        { env: ON, log },
      ));
    }
    // Never returns anything the caller could use to alter the response.
    expect(returned.every(r => r === undefined)).toBe(true);
    expect(lines[0]).toMatchObject({
      event: 'session_breaker_would_pause', sessionId: 'aea6a0ee', userId: 'u1', billingUserId: 'b1',
      turns: 40, multiple: 1, action: 'pause_for_confirmation', reason: 'turn_cap', isScheduled: false,
    });
    // floor(549/40)=13 turn multiples dominate floor(47/5)=9 spend multiples.
    expect(lines).toHaveLength(13);
    expect(lines.map(l => l.multiple)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(new Set(lines.map(l => l.turns)).size).toBe(13);
    expect(lines[12].spendUsd).toBeCloseTo((520 * 47) / 549, 2);
  });

  it('scheduled run reports pause_and_notify in the log only', () => {
    const lines: any[] = [];
    for (let t = 1; t <= 3; t++) {
      recordSessionBreakerShadowTurn(
        { sessionId: 'sched', isScheduled: true, costUsd: () => 2.5 },
        { env: ON, log: l => lines.push(JSON.parse(l)) },
      );
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ turns: 2, action: 'pause_and_notify', reason: 'spend_cap', isScheduled: true, multiple: 1 });
  });

  it('never throws even when cost computation or logging fails', () => {
    expect(() => recordSessionBreakerShadowTurn(
      { sessionId: 'x', isScheduled: false, costUsd: () => { throw new Error('boom'); } },
      { env: ON },
    )).not.toThrow();
    expect(() => {
      for (let i = 0; i < 41; i++) {
        recordSessionBreakerShadowTurn({ sessionId: 'y', isScheduled: false, costUsd: () => 0 },
          { env: ON, log: () => { throw new Error('log'); } });
      }
    }).not.toThrow();
  });

  it('isolates sessions and falls back to default caps on invalid env', () => {
    expect(readSessionBreakerShadowConfig({ SESSION_BREAKER_SHADOW: 'true', SESSION_BREAKER_SHADOW_MAX_TURNS: 'abc' }))
      .toEqual({ caps: { maxTurns: 40, maxSpendUsd: 5 } });
    const lines: any[] = [];
    for (let i = 0; i < 39; i++) {
      for (const s of ['a', 'b']) {
        recordSessionBreakerShadowTurn({ sessionId: s, isScheduled: false, costUsd: () => 0 }, { env: ON, log: l => lines.push(l) });
      }
    }
    expect(lines).toHaveLength(0);
  });
});
