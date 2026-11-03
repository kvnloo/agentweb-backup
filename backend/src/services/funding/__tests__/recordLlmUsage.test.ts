jest.mock('../../agentMode/deferredBillingMetering', () => ({
  meterWithResolvedBilling: jest.fn(),
}));

import { meterWithResolvedBilling } from '../../agentMode/deferredBillingMetering';
import {
  recordLlmUsage,
  customerUpstreamCost,
  openRouterByokCostUsd,
  type RecordLlmUsageInput,
} from '../recordLlmUsage';
import {
  __getRunFundingUnsetCountForTests,
  __resetRunFundingUnsetCountForTests,
  type RunFunding,
} from '../runFunding';
import {
  __resetAttemptUsageJournalForTests,
  bindAttemptUsageJournal,
} from '../attemptUsageJournal';

const mockedMeter = meterWithResolvedBilling as jest.Mock;

const baseCtx: RecordLlmUsageInput = {
  userId: 'user-1',
  billingUserId: 'billing-1',
  sessionId: 'session-1',
  model: 'anthropic.claude-sonnet-5',
  provider: 'openrouter',
  feature: 'agent_task',
  inputTokens: 100,
  outputTokens: 50,
};

function agentwebFunding(): RunFunding {
  return {
    route: 'agentweb',
    fallback: 'agentweb',
    ownerUserId: 'user-1',
    billingUserId: 'billing-1',
    resolvedAt: new Date().toISOString(),
  };
}

function customerFunding(): RunFunding {
  return {
    route: 'api_key',
    connectionId: 'conn-1',
    fallback: 'stop',
    ownerUserId: 'user-1',
    billingUserId: 'billing-1',
    resolvedAt: new Date().toISOString(),
  };
}

describe('recordLlmUsage (ENG-1816 F1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRunFundingUnsetCountForTests();
    __resetAttemptUsageJournalForTests();
  });

  it('agentweb route: calls meterWithResolvedBilling with the ctx unchanged, byte-identical to pre-F1 behavior', () => {
    recordLlmUsage(agentwebFunding(), baseCtx, 'test');
    expect(mockedMeter).toHaveBeenCalledTimes(1);
    expect(mockedMeter).toHaveBeenCalledWith(baseCtx);
  });

  it('undefined runFunding: falls back to meterWithResolvedBilling (today\'s behavior) and counts the unset call site', () => {
    expect(__getRunFundingUnsetCountForTests()).toBe(0);
    recordLlmUsage(undefined, baseCtx, 'some.unwrapped.callsite');
    expect(mockedMeter).toHaveBeenCalledTimes(1);
    expect(mockedMeter).toHaveBeenCalledWith(baseCtx);
    expect(__getRunFundingUnsetCountForTests()).toBe(1);
  });

  it('non-agentweb route: NEVER calls meterWithResolvedBilling — touches no existing rail', async () => {
    recordLlmUsage(customerFunding(), baseCtx, 'test');
    // recordToJournal is fire-and-forget; flush microtasks before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedMeter).not.toHaveBeenCalled();
  });

  describe('customer-funded attempt record (ENG-2106)', () => {
    async function recorded(funding: RunFunding, ctx: RecordLlmUsageInput) {
      const record = jest.fn().mockResolvedValue(undefined);
      bindAttemptUsageJournal({ record });
      recordLlmUsage(funding, ctx, 'test');
      await Promise.resolve();
      await Promise.resolve();
      expect(record).toHaveBeenCalledTimes(1);
      return record.mock.calls[0][0];
    }
    const pricedCtx: RecordLlmUsageInput = { ...baseCtx, model: 'gpt-4.1', provider: 'openai' };

    it('records one settled attempt with the real funding source, connection, tokens and run', async () => {
      const attempt = await recorded(customerFunding(), { ...pricedCtx, cacheReadTokens: 7, cacheWriteTokens: 3 });
      expect(attempt).toMatchObject({
        fundingSource: 'api_key',
        connectionId: 'conn-1',
        runId: 'session-1',
        userId: 'user-1',
        billingUserId: 'billing-1',
        requestedModel: 'gpt-4.1',
        actualModel: 'gpt-4.1',
        requestedBackend: 'emma_raw',
        outcome: 'succeeded',
        settlementState: 'settled',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 3 },
      });
      expect(attempt.startedAt).toBe(attempt.endedAt);
    });

    it('credits the key owner, not the member running the turn, when the run carries a funding principal', async () => {
      const attempt = await recorded({ ...customerFunding(), fundingPrincipalId: 'key-owner' }, pricedCtx);
      expect(attempt.fundingPrincipalId).toBe('key-owner');
      expect(attempt.userId).toBe('user-1');
    });

    it('falls back to the run owner as the paying account until the connection resolver sets one', async () => {
      expect((await recorded(customerFunding(), pricedCtx)).fundingPrincipalId).toBe('user-1');
    });

    it('uses the provider generation id as the attempt id so a retry cannot double-record, else makes one', async () => {
      expect((await recorded(customerFunding(), { ...pricedCtx, eventId: 'gen-abc' })).attemptId).toBe('gen-abc');
      const generated = (await recorded(customerFunding(), pricedCtx)).attemptId;
      expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('attributes a call with no session to its task, and a call with neither to a run of its own', async () => {
      const { sessionId: _s, ...noSession } = pricedCtx;
      expect((await recorded(customerFunding(), { ...noSession, taskId: 'task-9' })).runId).toBe('task-9');
      const orphan = await recorded(customerFunding(), { ...noSession, eventId: 'gen-orphan' });
      expect(orphan.runId).toBe('unattributed-gen-orphan');
    });

    it('prices the list-equivalent cost from the price book and says which book', async () => {
      const attempt = await recorded(customerFunding(), pricedCtx);
      // gpt-4.1: $2/M in, $8/M out -> 100*2 + 50*8 micro-USD
      expect(attempt.listEquivalentMicroUsd).toBe(600);
      expect(attempt.priceVersion).toEqual(expect.any(String));
      expect(attempt.priceVersion).not.toBe('');
    });

    it('leaves list-equivalent cost ABSENT, never zero, for a model with no price', async () => {
      const attempt = await recorded(customerFunding(), { ...pricedCtx, model: 'no-such-model-xyz' });
      expect(attempt).not.toHaveProperty('listEquivalentMicroUsd');
      expect(attempt).not.toHaveProperty('priceVersion');
    });

    it('records the customer\'s own provider charge only when the response reported one', async () => {
      const withCost = await recorded(customerFunding(), { ...pricedCtx, upstreamCostUsd: 0.0123 });
      expect(withCost.customerEstimateMicroUsd).toBe(12_300);
      expect(withCost.costProvenance).toBe('openrouter:upstream_inference_cost');
      for (const bad of [undefined, 0, -1, NaN, Infinity]) {
        const attempt = await recorded(customerFunding(), { ...pricedCtx, upstreamCostUsd: bad as number });
        expect(attempt).not.toHaveProperty('customerEstimateMicroUsd');
        expect(attempt).not.toHaveProperty('costProvenance');
      }
    });

    it('keeps a real charge too small to round to a whole micro-dollar as 1, not 0', async () => {
      const attempt = await recorded(customerFunding(), { ...pricedCtx, upstreamCostUsd: 1e-9 });
      expect(attempt.customerEstimateMicroUsd).toBe(1);
    });

    it('does not read AgentWeb\'s own cost override as the customer\'s charge', async () => {
      const attempt = await recorded(customerFunding(), { ...pricedCtx, costUsdOverride: 5 });
      expect(attempt).not.toHaveProperty('customerEstimateMicroUsd');
    });

    it('registers the pending journal write so a graceful shutdown drains it', async () => {
      const { cronJobRegistry } = require('../../../utils/cronJobRegistry');
      const trackSpy = jest.spyOn(cronJobRegistry, 'track');
      bindAttemptUsageJournal({ record: jest.fn().mockResolvedValue(undefined) });
      recordLlmUsage(customerFunding(), pricedCtx, 'test');
      expect(trackSpy).toHaveBeenCalledWith('attemptUsageJournal', expect.any(Promise));
      trackSpy.mockRestore();
    });

    it('survives an attempt that cannot be built, without throwing or touching any rail', () => {
      const record = jest.fn();
      bindAttemptUsageJournal({ record });
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const pricing = require('../../../utils/llmPricing');
      const priceSpy = jest.spyOn(pricing, 'getModelPrice').mockImplementation(() => { throw new Error('price book broke'); });
      expect(() => recordLlmUsage(customerFunding(), pricedCtx, 'test')).not.toThrow();
      priceSpy.mockRestore();
      expect(record).not.toHaveBeenCalled();
      expect(mockedMeter).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('customerUpstreamCost (what callLLM passes through)', () => {
    it('reports the upstream cost only on a BYOK response with a positive cost', () => {
      expect(customerUpstreamCost({ is_byok: true, cost_details: { upstream_inference_cost: 0.02 } })).toEqual({ upstreamCostUsd: 0.02 });
    });
    it.each([
      ['not BYOK', { is_byok: false, cost_details: { upstream_inference_cost: 0.02 } }],
      ['BYOK flag missing', { cost_details: { upstream_inference_cost: 0.02 } }],
      ['BYOK without a cost', { is_byok: true }],
      ['BYOK with null details', { is_byok: true, cost_details: null }],
      ['zero cost', { is_byok: true, cost_details: { upstream_inference_cost: 0 } }],
      ['negative cost', { is_byok: true, cost_details: { upstream_inference_cost: -1 } }],
      ['non-finite cost', { is_byok: true, cost_details: { upstream_inference_cost: Infinity } }],
      ['string cost', { is_byok: true, cost_details: { upstream_inference_cost: '0.02' } }],
    ])('reports nothing when %s', (_label, usage) => {
      expect(customerUpstreamCost(usage as any)).toEqual({});
    });
  });

  it('agentweb route: the journal-only cost field never reaches an AgentWeb rail', () => {
    recordLlmUsage(agentwebFunding(), { ...baseCtx, upstreamCostUsd: 0.5 }, 'test');
    expect(mockedMeter).toHaveBeenCalledTimes(1);
    expect(mockedMeter.mock.calls[0][0]).toEqual(baseCtx);
    expect(mockedMeter.mock.calls[0][0]).not.toHaveProperty('upstreamCostUsd');
  });

  it('unset funding: the journal-only cost field is stripped there too', () => {
    recordLlmUsage(undefined, { ...baseCtx, upstreamCostUsd: 0.5 }, 'test');
    expect(mockedMeter.mock.calls[0][0]).not.toHaveProperty('upstreamCostUsd');
  });

  it('a journal write failure is logged with the attempt id and a code, never the error object', async () => {
    const record = jest.fn().mockRejectedValue(Object.assign(new Error('secret request details'), { code: 'ThrottlingException' }));
    bindAttemptUsageJournal({ record });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    recordLlmUsage(customerFunding(), { ...baseCtx, eventId: 'gen-77' }, 'test');
    await new Promise((r) => setImmediate(r));
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    spy.mockRestore();
    expect(logged).toContain('gen-77');
    expect(logged).toContain('ThrottlingException');
    expect(logged).not.toContain('secret request details');
  });

  it('a journal failure is swallowed (fail-open) and never throws out of recordLlmUsage', async () => {
    const record = jest.fn().mockRejectedValue(new Error('boom'));
    bindAttemptUsageJournal({ record });

    expect(() => recordLlmUsage(customerFunding(), baseCtx, 'test')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1);
  });

  describe('openRouterByokCostUsd (ENG-2720: upstream tokens plus OpenRouter\'s own charge)', () => {
    it('adds the router charge (web-search fee) to the upstream bill when the response reports the server tool use', () => {
      // the shape of a real response: Exa search fee $0.007, token bill $0.0005, one search reported
      expect(openRouterByokCostUsd({ cost: 0.007, cost_details: { upstream_inference_cost: 0.00049 }, server_tool_use_details: { web_search_requests: 1, tool_calls_executed: 1 } })).toBeCloseTo(0.00749, 8);
      expect(openRouterByokCostUsd({ cost: 0.005, cost_details: { upstream_inference_cost: 0.0007 }, server_tool_use_details: { web_search_requests: 1 } })).toBeCloseTo(0.0057, 8);
    });
    it('adds a platform fee that is smaller than the token bill even without a server tool', () => {
      expect(openRouterByokCostUsd({ cost: 0.0005, cost_details: { upstream_inference_cost: 0.01 } })).toBeCloseTo(0.0105, 8);
    });
    it('NEVER drops a real search fee, even when the response lacks the server-tool-use field (Luna: fee is several times the token bill)', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      for (const shape of [undefined, {}, { web_search_requests: 0 }, 'weird', ['x'], { nested: { web_search_requests: 1 } }]) {
        const usage: any = { cost: 0.007, cost_details: { upstream_inference_cost: 0.0005 } };
        if (shape !== undefined) usage.server_tool_use_details = shape;
        expect(openRouterByokCostUsd(usage)).toBeCloseTo(0.0075, 8);
      }
      warn.mockRestore();
    });
    it('books both bills for a charge that equals the token bill with no tool use, and warns (tripwire only), at most once a minute', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const now = jest.spyOn(Date, 'now');
      const shape = { cost: 0.0068, cost_details: { upstream_inference_cost: 0.0068 } };
      // a clock later than any warning an earlier test may have triggered, so the throttle starts open
      const base = Date.now() + 24 * 3_600_000;
      now.mockReturnValue(base);
      expect(openRouterByokCostUsd(shape)).toBeCloseTo(0.0136, 8);
      expect(openRouterByokCostUsd(shape)).toBeCloseTo(0.0136, 8);
      expect(openRouterByokCostUsd({ cost: 0.02, cost_details: { upstream_inference_cost: 0.0068 } })).toBeCloseTo(0.0268, 8);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toEqual({ usageKeys: ['cost', 'cost_details'], costDetailKeys: ['upstream_inference_cost'] });
      now.mockReturnValue(base + 61_000);
      openRouterByokCostUsd(shape);
      expect(warn).toHaveBeenCalledTimes(2);
      now.mockRestore();
      warn.mockRestore();
    });
    it('does not warn for real shapes: search with its tool use, a platform fee below the token bill, no router charge', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // a clock later than any earlier test's throttle timestamp, so a wrongly-fired warning would not be hidden by the throttle
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 72 * 3_600_000);
      openRouterByokCostUsd({ cost: 0.007, cost_details: { upstream_inference_cost: 0.0005 }, server_tool_use_details: { web_search_requests: 1 } });
      openRouterByokCostUsd({ cost: 0.0005, cost_details: { upstream_inference_cost: 0.01 } });
      openRouterByokCostUsd({ cost: 0, cost_details: { upstream_inference_cost: 0.00004 } });
      expect(warn).not.toHaveBeenCalled();
      now.mockRestore();
      warn.mockRestore();
    });
    it('still adds the charge when it equals the token bill but a server tool really ran', () => {
      expect(openRouterByokCostUsd({ cost: 0.007, cost_details: { upstream_inference_cost: 0.007 }, server_tool_use_details: { web_search_requests: 1 } })).toBeCloseTo(0.014, 8);
    });
    it('returns the upstream bill alone when OpenRouter charged nothing or an unusable amount', () => {
      for (const cost of [0, -1, NaN, Infinity, undefined, '0.007' as unknown as number]) {
        expect(openRouterByokCostUsd({ cost, cost_details: { upstream_inference_cost: 0.0119 } })).toBe(0.0119);
      }
    });
    it('stays undefined with no upstream bill and no fee, so the price book prices the tokens as before', () => {
      for (const upstream of [undefined, 0, -1, NaN, 'x' as unknown as number]) {
        expect(openRouterByokCostUsd({ cost: 0, cost_details: { upstream_inference_cost: upstream } })).toBeUndefined();
      }
      expect(openRouterByokCostUsd({})).toBeUndefined();
    });
    it('books a fee with no upstream bill on top of the book token cost instead of dropping it', () => {
      expect(openRouterByokCostUsd({ cost: 0.007 }, 0.0004)).toBeCloseTo(0.0074, 8);
      expect(openRouterByokCostUsd({ cost: 0.007 })).toBe(0.007);
      expect(openRouterByokCostUsd({ cost: 0.007 }, NaN)).toBe(0.007);
    });
  });
});
