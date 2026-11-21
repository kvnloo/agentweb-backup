import {
  __resetSessionBreakerShadowForTests,
  readSessionBreakerShadowConfig,
  recordSessionBreakerShadowTurn,
  shadowTurnCostUsd,
} from '../sessionBreakerShadow';
import { evaluateSessionSpendBreaker } from '../sessionSpendBreaker';

const ON = { SESSION_BREAKER_SHADOW: 'true', SESSION_BREAKER_SHADOW_MAX_TURNS: '40', SESSION_BREAKER_SHADOW_MAX_SPEND_USD: '5' };

describe('sessionBreakerShadow (ENG-2953)', () => {
  beforeEach(() => __resetSessionBreakerShadowForTests());

  it('flag explicitly off: evaluator never invoked, cost never computed, nothing logged', () => {
    const evaluate = jest.fn(evaluateSessionSpendBreaker);
    const log = jest.fn();
    const costUsd = jest.fn(() => 100);
    for (const env of [{ SESSION_BREAKER_SHADOW: 'false' }, { SESSION_BREAKER_SHADOW: ' FALSE ' }, { SESSION_BREAKER_SHADOW: '0' }, { SESSION_BREAKER_SHADOW: 'off' }]) {
      for (let i = 0; i < 100; i++) {
        recordSessionBreakerShadowTurn({ sessionId: 's', isScheduled: false, costUsd }, { env, log, evaluate });
      }
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(costUsd).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(readSessionBreakerShadowConfig({ SESSION_BREAKER_SHADOW: 'false' })).toBeNull();
  });

  it('flag unset (the prod default): on with the default caps, and logs the would-pause line', () => {
    expect(readSessionBreakerShadowConfig({})).toEqual({ caps: { maxTurns: 40, maxSpendUsd: 5 } });
    const lines: Array<Record<string, unknown>> = [];
    const returned: unknown[] = [];
    for (let t = 1; t <= 41; t++) {
      returned.push(recordSessionBreakerShadowTurn(
        { sessionId: 'unset', isScheduled: false, costUsd: () => 0 },
        { env: {}, log: l => lines.push(JSON.parse(l)) },
      ));
    }
    expect(returned.every(r => r === undefined)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'session_breaker_would_pause', sessionId: 'unset', turns: 40, multiple: 1, reason: 'turn_cap' });
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

describe('shadowTurnCostUsd: spend per turn by the ledger rule (BYOK reports usage.cost 0)', () => {
  const TOKENS = 0.01;

  it('plain BYOK call: the upstream bill, not the 0 in usage.cost', () => {
    expect(shadowTurnCostUsd({ is_byok: true, cost: 0, cost_details: { upstream_inference_cost: 0.02 } }, TOKENS)).toBeCloseTo(0.02, 10);
  });

  it('BYOK call with a search fee: upstream bill plus the OpenRouter fee', () => {
    const usage = { is_byok: true, cost: 0.007, cost_details: { upstream_inference_cost: 0.0006 }, server_tool_use_details: { web_search_requests: 1 } };
    expect(shadowTurnCostUsd(usage, TOKENS)).toBeCloseTo(0.0076, 10);
  });

  it('BYOK with no cost reported at all: the price-book token cost, not 0', () => {
    expect(shadowTurnCostUsd({ is_byok: true, cost: 0 }, TOKENS)).toBe(TOKENS);
    expect(shadowTurnCostUsd({ is_byok: true }, TOKENS)).toBe(TOKENS);
  });

  it('BYOK fee with no upstream bill: price-book tokens plus the fee', () => {
    expect(shadowTurnCostUsd({ is_byok: true, cost: 0.005 }, TOKENS)).toBeCloseTo(0.015, 10);
  });

  it('not BYOK: usage.cost when positive, else the price-book token cost', () => {
    expect(shadowTurnCostUsd({ cost: 0.05 }, TOKENS)).toBe(0.05);
    expect(shadowTurnCostUsd({ cost: 0 }, TOKENS)).toBe(TOKENS);
    expect(shadowTurnCostUsd({}, TOKENS)).toBe(TOKENS);
    expect(shadowTurnCostUsd({ cost: -1 }, TOKENS)).toBe(TOKENS);
  });

  it('no usage block: 0; a bad token cost never yields NaN', () => {
    expect(shadowTurnCostUsd(undefined, TOKENS)).toBe(0);
    expect(shadowTurnCostUsd(null, TOKENS)).toBe(0);
    expect(shadowTurnCostUsd({ is_byok: true, cost: 0 }, NaN)).toBe(0);
  });

  it('BYOK session now reaches the spend cap (it stayed at $0 before, so only the turn cap could fire)', () => {
    const lines: Array<Record<string, unknown>> = [];
    const usage = { is_byok: true, cost: 0, cost_details: { upstream_inference_cost: 0.03 } };
    for (let t = 1; t <= 3; t++) {
      recordSessionBreakerShadowTurn(
        { sessionId: 'byok', isScheduled: false, costUsd: () => shadowTurnCostUsd(usage, 0) },
        { env: { SESSION_BREAKER_SHADOW_MAX_SPEND_USD: '0.05' }, log: l => lines.push(JSON.parse(l)) },
      );
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'session_breaker_would_pause', turns: 2, spendUsd: 0.06, reason: 'spend_cap', multiple: 1 });
  });
});
