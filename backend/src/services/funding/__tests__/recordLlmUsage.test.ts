jest.mock('../../agentMode/deferredBillingMetering', () => ({
  meterWithResolvedBilling: jest.fn(),
}));

import { meterWithResolvedBilling } from '../../agentMode/deferredBillingMetering';
import {
  recordLlmUsage,
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

  it('non-agentweb route: records exactly one attempt to the journal, with the real funding source and no fabricated cost', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    bindAttemptUsageJournal({ record });

    const funding = customerFunding();
    recordLlmUsage(funding, baseCtx, 'test');
    await Promise.resolve();
    await Promise.resolve();

    expect(record).toHaveBeenCalledTimes(1);
    const attempt = record.mock.calls[0][0];
    expect(attempt.fundingSource).toBe('api_key');
    expect(attempt.fundingPrincipalId).toBe(funding.ownerUserId);
    expect(attempt.connectionId).toBe('conn-1');
    expect(attempt.requestedModel).toBe(baseCtx.model);
    expect(attempt.usage.inputTokens).toBe(100);
    expect(attempt.usage.outputTokens).toBe(50);
    // Never fabricate a cost: F1 has no price/entitlement source, so both stay unset
    // rather than defaulting to 0 (0 and "unknown" are different answers).
    expect(attempt.customerEstimateMicroUsd).toBeUndefined();
    expect(attempt.listEquivalentMicroUsd).toBeUndefined();
  });

  it('a journal failure is swallowed (fail-open) and never throws out of recordLlmUsage', async () => {
    const record = jest.fn().mockRejectedValue(new Error('boom'));
    bindAttemptUsageJournal({ record });

    expect(() => recordLlmUsage(customerFunding(), baseCtx, 'test')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(record).toHaveBeenCalledTimes(1);
  });
});
