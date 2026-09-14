/**
 * ENG-1934 (ENG-1250 §6) — LLM calls reach the spend ledger alongside vendor spend.
 *
 * Each block names the acceptance criterion it proves. The property running
 * through all of them: the aggregate row and the spend event move TOGETHER —
 * one transaction, one id — so the ledger can be reconciled against the rail
 * that predates it rather than merely resembling it.
 */
jest.mock('../services/usageRecordDb', () => {
  const actual = jest.requireActual('../services/usageRecordDb');
  return {
    ...actual,
    usageRecordDb: {
      ...actual.usageRecordDb,
      incrementUsage: jest.fn(),
      incrementUsageWithSpendEvent: jest.fn(),
    },
  };
});

import { recordUsage, RecordUsageContext } from '../services/usageRecorderService';
import { usageRecordDb } from '../services/usageRecordDb';
import {
  getDroppedWriteTotals,
  resetDroppedWriteState,
  setDroppedWriteAlertSink,
} from '../services/usageWriteFailureMonitor';
import { LLM_PRICE_BOOK_PROVENANCE, videoClipCount, videoGenerationCostUsd } from '../utils/llmPricing';
import { validateSpendEvent } from '../services/spendEventDb';

const mockTxn = usageRecordDb.incrementUsageWithSpendEvent as jest.Mock;
const mockPlain = usageRecordDb.incrementUsage as jest.Mock;

const SONNET = 'anthropic.claude-sonnet-4-6';

const ctx = (over: Partial<RecordUsageContext> = {}): RecordUsageContext => ({
  userId: 'member-1',
  billingUserId: 'owner-1',
  onBehalfOf: 'member-1',
  model: SONNET,
  provider: 'bedrock',
  feature: 'agent_chat',
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  sessionId: 'sess-1',
  taskId: 'task-1',
  ...over,
});

const eventOf = (call = 0) => mockTxn.mock.calls[call][1];
const incrementOf = (call = 0) => mockTxn.mock.calls[call][0];

describe('recordUsage → spend ledger (ENG-1934)', () => {
  const originalSwitch = process.env.SPEND_LEDGER_LLM_DUAL_WRITE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SPEND_LEDGER_LLM_DUAL_WRITE; // default: ON
    resetDroppedWriteState();
    setDroppedWriteAlertSink(() => {});
    mockTxn.mockResolvedValue('applied');
    mockPlain.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalSwitch === undefined) delete process.env.SPEND_LEDGER_LLM_DUAL_WRITE;
    else process.env.SPEND_LEDGER_LLM_DUAL_WRITE = originalSwitch;
  });

  describe('AC1 — one settled event, in the same transaction as the aggregate row', () => {
    it('writes both rails in ONE transaction, and never the plain aggregate alongside it', async () => {
      await recordUsage(ctx());

      expect(mockTxn).toHaveBeenCalledTimes(1);
      expect(mockPlain).not.toHaveBeenCalled();
    });

    it('the event is a valid, settled ledger row for the billing subject', async () => {
      await recordUsage(ctx());
      const event = eventOf();

      // The same validator the store enforces — a malformed event would be
      // rejected in production, so passing it here is not a formality.
      expect(() => validateSpendEvent(event)).not.toThrow();
      expect(event).toMatchObject({
        billingUserId: 'owner-1',
        actingUserId: 'member-1',
        onBehalfOf: 'member-1',
        provider: 'bedrock',
        operation: SONNET,
        feature: 'agent_chat',
        lifecycle: 'settled',
        costSource: 'allocated',
        references: { sessionId: 'sess-1', taskId: 'task-1' },
      });
    });

    it('carries exactly the aggregate row\'s cost, so the two rails reconcile to the micro-dollar', async () => {
      await recordUsage(ctx());

      expect(eventOf().costMicroUsd).toBe(incrementOf().costMicroUsd);
      expect(eventOf().costMicroUsd).toBeGreaterThan(0);
    });

    it('leaves the aggregate row exactly as the switch-off path writes it', async () => {
      await recordUsage(ctx());
      const onIncrement = incrementOf();

      jest.clearAllMocks();
      process.env.SPEND_LEDGER_LLM_DUAL_WRITE = 'false';
      await recordUsage(ctx());

      expect(mockPlain).toHaveBeenCalledTimes(1);
      expect(mockPlain.mock.calls[0][0]).toEqual(onIncrement);
    });
  });

  describe('AC1 — both rails land on the same UTC day', () => {
    it('derives the aggregate date and the event instant from ONE clock read', async () => {
      await recordUsage(ctx());

      expect(eventOf().occurredAt.slice(0, 10)).toBe(incrementOf().date);
    });

    it('a caller that pins date and instant from an earlier moment keeps both — even across midnight', async () => {
      await recordUsage(ctx({ date: '2026-09-13', occurredAt: '2026-09-13T23:59:59.990Z' }));

      expect(incrementOf().date).toBe('2026-09-13');
      expect(eventOf().occurredAt).toBe('2026-09-13T23:59:59.990Z');
      expect(eventOf().billingMonth).toBe('2026-09');
    });
  });

  describe('AC2 — the unit says how the call was priced', () => {
    it('a token-priced call records llm_token, quantity = every token billed', async () => {
      await recordUsage(ctx());

      expect(eventOf()).toMatchObject({ unit: 'llm_token', quantity: 1000 + 200 + 50 + 10 });
    });

    it('a per-generation model records llm_generation, quantity 1', async () => {
      await recordUsage(
        ctx({
          model: 'gpt-image-1',
          provider: 'openai',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdOverride: 0.04,
          costProvenance: LLM_PRICE_BOOK_PROVENANCE,
        }),
      );

      expect(eventOf()).toMatchObject({ unit: 'llm_generation', quantity: 1, costMicroUsd: 40_000 });
    });

    it('a multi-clip video records the clip count its cost was multiplied by', async () => {
      await recordUsage(
        ctx({
          model: 'veo-3.1-generate-preview',
          provider: 'google',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdOverride: videoGenerationCostUsd('veo-3.1-generate-preview', 16),
          costProvenance: LLM_PRICE_BOOK_PROVENANCE,
          generationCount: videoClipCount(16),
        }),
      );

      expect(videoClipCount(16)).toBe(2);
      expect(eventOf()).toMatchObject({ unit: 'llm_generation', quantity: 2 });
    });

    it('a per-generation model with NO override still writes nothing on either rail (ENG-1691 unchanged)', async () => {
      await recordUsage(ctx({ model: 'gpt-image-1', provider: 'openai' }));

      expect(mockTxn).not.toHaveBeenCalled();
      expect(mockPlain).not.toHaveBeenCalled();
    });
  });

  describe('AC3 — a retried write adds the cost once', () => {
    it('namespaces the caller\'s call id, so a replay reuses it', async () => {
      await recordUsage(ctx({ eventId: 'msg_bdrk_01' }));
      await recordUsage(ctx({ eventId: 'msg_bdrk_01' }));

      expect(eventOf(0).eventId).toBe('llm:msg_bdrk_01');
      expect(eventOf(1).eventId).toBe('llm:msg_bdrk_01');
    });

    it('a duplicate is a no-op on BOTH rails — the aggregate is not written a second time', async () => {
      mockTxn.mockResolvedValueOnce('applied').mockResolvedValueOnce('duplicate');

      await recordUsage(ctx({ eventId: 'msg_bdrk_01' }));
      await recordUsage(ctx({ eventId: 'msg_bdrk_01' }));

      expect(mockTxn).toHaveBeenCalledTimes(2);
      expect(mockPlain).not.toHaveBeenCalled();
      expect(getDroppedWriteTotals().count).toBe(0);
    });

    it('retries a transaction conflict with the SAME event id — built once, before the loop', async () => {
      mockTxn.mockResolvedValueOnce('conflict').mockResolvedValueOnce('applied');

      await recordUsage(ctx());

      expect(mockTxn).toHaveBeenCalledTimes(2);
      expect(eventOf(1).eventId).toBe(eventOf(0).eventId);
      expect(eventOf(0).eventId).toMatch(/^gen:/);
      expect(mockPlain).not.toHaveBeenCalled();
    });

    it('without a call id, two genuinely separate calls get two events', async () => {
      await recordUsage(ctx());
      await recordUsage(ctx());

      expect(eventOf(0).eventId).not.toBe(eventOf(1).eventId);
    });
  });

  describe('AC4 — every event carries its rate provenance', () => {
    it('a token cost from the backend price book carries the book\'s version', async () => {
      await recordUsage(ctx());

      expect(eventOf().rateCardVersion).toBe(LLM_PRICE_BOOK_PROVENANCE);
      expect(LLM_PRICE_BOOK_PROVENANCE).toMatch(/^llm-price-book:\d{4}-\d{2}-\d{2}$/);
    });

    it('a gateway-reported cost is attributed to the caller, not claimed by the book', async () => {
      await recordUsage(ctx({ provider: 'openrouter', costUsdOverride: 0.0123 }));

      expect(eventOf().rateCardVersion).toBe('caller:openrouter');
      expect(eventOf().costMicroUsd).toBe(12_300);
    });

    it('an override the caller read from the book says so', async () => {
      await recordUsage(ctx({ costUsdOverride: 0.0123, costProvenance: LLM_PRICE_BOOK_PROVENANCE }));

      expect(eventOf().rateCardVersion).toBe(LLM_PRICE_BOOK_PROVENANCE);
    });
  });

  describe('AC5 — an unpriced model never becomes a $0 spend event', () => {
    it('writes the aggregate row tagged unpriced, and no event', async () => {
      await recordUsage(ctx({ model: 'model-nobody-priced' }));

      expect(mockTxn).not.toHaveBeenCalled();
      expect(mockPlain).toHaveBeenCalledTimes(1);
      expect(mockPlain.mock.calls[0][0]).toMatchObject({ costSource: 'unpriced', costMicroUsd: 0 });
    });
  });

  describe('AC6 — a ledger failure never fails the call, and is counted', () => {
    it('falls back to the plain aggregate write and records the loss', async () => {
      mockTxn.mockRejectedValue(Object.assign(new Error('AccessDenied'), { code: 'AccessDeniedException' }));

      await expect(recordUsage(ctx())).resolves.toBeUndefined();

      expect(mockPlain).toHaveBeenCalledTimes(1);
      expect(mockPlain.mock.calls[0][0]).toEqual(incrementOf());
      expect(getDroppedWriteTotals()).toMatchObject({ count: 1, lostMicroUsd: eventOf().costMicroUsd });
    });

    it('still resolves when the fallback write fails too — and the loss is still counted', async () => {
      mockTxn.mockRejectedValue(new Error('ledger down'));
      mockPlain.mockRejectedValue(new Error('aggregate down'));

      await expect(recordUsage(ctx())).resolves.toBeUndefined();
      // Recorded before the fallback, so a double failure cannot skip the monitor.
      expect(getDroppedWriteTotals().count).toBe(1);
    });
  });

  describe('AC7 — the kill switch', () => {
    it('SPEND_LEDGER_LLM_DUAL_WRITE=false writes the aggregate only, exactly as before', async () => {
      process.env.SPEND_LEDGER_LLM_DUAL_WRITE = 'false';

      await recordUsage(ctx({ eventId: 'msg_bdrk_01' }));

      expect(mockTxn).not.toHaveBeenCalled();
      expect(mockPlain).toHaveBeenCalledTimes(1);
    });

    it('any other value leaves it on — only an explicit "false" turns it off', async () => {
      process.env.SPEND_LEDGER_LLM_DUAL_WRITE = '0';

      await recordUsage(ctx());

      expect(mockTxn).toHaveBeenCalledTimes(1);
    });
  });
});
