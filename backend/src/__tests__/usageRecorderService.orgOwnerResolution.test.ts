/**
 * ENG-2286 — spend is recorded against the org's BILLING ROOT, not the member.
 *
 * The enforcement gate pools an org member onto the org owner
 * (`resolveBillingUserId`) and never looks at the member's own id. Vendor call
 * sites that pass no `billingUserId` used to fall back to `userId`, so an org
 * member's vendor spend landed on the member — outside the owner's cap and outside
 * enforcement ($301.64 across 7 members, 97% vendor, as of 2026-10-05).
 *
 * Billing-critical (which account a charge counts against), so retained. The
 * properties that matter:
 *   - the owner is resolved when the caller names none, and the ACTING user is
 *     still recorded as the actor;
 *   - an explicit `billingUserId` is resolved too (the X account owner of a member's connected
 *     account IS the member), and an explicit id that is already a billing root is unchanged;
 *   - it is resolved ONCE, so the aggregate, the spend event and the legacy
 *     fallback can never split one call across two owners;
 *   - it can never lose a record (resolver failure → old behaviour, never a throw);
 *   - it is reversible without a deploy (kill switch).
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

import {
  recordUsage,
  recordVendorUsage,
  __setBillingOwnerResolverForTests,
  SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV,
} from '../services/usageRecorderService';
import { usageRecordDb } from '../services/usageRecordDb';
import { resetDroppedWriteState, setDroppedWriteAlertSink } from '../services/usageWriteFailureMonitor';

const mockTxn = usageRecordDb.incrementUsageWithSpendEvent as jest.Mock;
const mockPlain = usageRecordDb.incrementUsage as jest.Mock;

const MEMBER = 'member-1';
const OWNER = 'owner-1';

const vendor = (over: Record<string, unknown> = {}) => ({
  userId: MEMBER,
  provider: 'apollo',
  operation: 'waterfall_email',
  feature: 'crm_enrichment',
  unit: 'enrichment',
  quantity: 1,
  costUsd: 0.5,
  costSource: 'allocated' as const,
  ...over,
});

const llm = (over: Record<string, unknown> = {}) => ({
  userId: MEMBER,
  model: 'anthropic.claude-sonnet-4-6',
  provider: 'bedrock',
  feature: 'agent_chat',
  inputTokens: 1000,
  outputTokens: 200,
  ...over,
});

describe('recorder resolves the org billing owner (ENG-2286)', () => {
  const originalSwitch = process.env[SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV];
  let resolver: jest.Mock;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetDroppedWriteState();
    setDroppedWriteAlertSink(() => {});
    delete process.env[SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV];
    mockTxn.mockResolvedValue('applied');
    mockPlain.mockResolvedValue(undefined);
    // MEMBER belongs to OWNER's org; everyone else bills themselves.
    resolver = jest.fn(async (id: string) => (id === MEMBER ? OWNER : id));
    __setBillingOwnerResolverForTests(resolver);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    __setBillingOwnerResolverForTests(null);
    errorSpy.mockRestore();
    if (originalSwitch === undefined) delete process.env[SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV];
    else process.env[SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV] = originalSwitch;
  });

  describe('vendor spend (the leak: callers that pass only userId)', () => {
    it("bills the org OWNER, and still records the member as the actor, on both rails", async () => {
      await recordVendorUsage(vendor());

      const [increment, event] = mockTxn.mock.calls[0];
      expect(increment.billingUserId).toBe(OWNER);
      expect(event.billingUserId).toBe(OWNER);
      expect(event.actingUserId).toBe(MEMBER); // who did it is preserved
    });

    it("an explicit billingUserId that is already a billing root is unchanged (resolution is idempotent)", async () => {
      await recordVendorUsage(vendor({ billingUserId: 'explicit-9' }));

      const [increment, event] = mockTxn.mock.calls[0];
      expect(increment.billingUserId).toBe('explicit-9');
      expect(event.billingUserId).toBe('explicit-9');
    });

    it("an explicit billingUserId that is an org MEMBER resolves to the owner (the X-account case, 2026-10-05 leak)", async () => {
      // twitterService passes billingUserId = the connected X account's owner, which is the member.
      await recordVendorUsage(vendor({ userId: 'someone-else', billingUserId: MEMBER }));

      const [increment, event] = mockTxn.mock.calls[0];
      expect(increment.billingUserId).toBe(OWNER);
      expect(event.billingUserId).toBe(OWNER);
      expect(resolver).toHaveBeenCalledWith(MEMBER);
    });

    it("an explicit 'system' or anon payer is never resolved", async () => {
      await recordVendorUsage(vendor({ billingUserId: 'system' }));
      await recordVendorUsage(vendor({ billingUserId: 'anon_x1' }));

      expect(mockTxn.mock.calls[0][1].billingUserId).toBe('system');
      expect(mockTxn.mock.calls[1][1].billingUserId).toBe('anon_x1');
      expect(resolver).not.toHaveBeenCalled();
    });

    it("a non-member bills themselves", async () => {
      await recordVendorUsage(vendor({ userId: 'solo-user' }));

      const [increment, event] = mockTxn.mock.calls[0];
      expect(increment.billingUserId).toBe('solo-user');
      expect(event.billingUserId).toBe('solo-user');
    });

    it("never resolves for 'system' or anonymous ids (no AW-Users row to pool from)", async () => {
      await recordVendorUsage(vendor({ userId: undefined }));
      await recordVendorUsage(vendor({ userId: 'anon_abc123' }));

      expect(resolver).not.toHaveBeenCalled();
      expect(mockTxn.mock.calls[0][1].billingUserId).toBe('system');
      expect(mockTxn.mock.calls[1][1].billingUserId).toBe('anon_abc123');
    });
  });

  describe('one call, one owner (resolved once)', () => {
    it("the legacy fallback after a failed atomic write bills the SAME owner as the ledger would", async () => {
      // The priced atomic write fails after retries → the recorder falls back to the
      // plain aggregate write. It must not re-derive the billing id and drift.
      mockTxn.mockRejectedValue(new Error('transaction failed'));

      await recordVendorUsage(vendor());

      expect(mockPlain).toHaveBeenCalledTimes(1);
      expect(mockPlain.mock.calls[0][0].billingUserId).toBe(OWNER);
      // And it was resolved exactly once for the whole call.
      expect(resolver).toHaveBeenCalledTimes(1);
    });
  });

  describe('LLM spend (same fallback, same fix)', () => {
    it("bills the org owner when the caller names none, on the aggregate and the event", async () => {
      await recordUsage(llm());

      const [increment, event] = mockTxn.mock.calls[0];
      expect(increment.billingUserId).toBe(OWNER);
      expect(event.billingUserId).toBe(OWNER);
      expect(event.actingUserId).toBe(MEMBER);
    });

    it("keeps an explicit billingUserId that is already a billing root, and resolves a member's to the owner", async () => {
      await recordUsage(llm({ billingUserId: 'explicit-9' }));
      await recordUsage(llm({ billingUserId: MEMBER }));

      expect(mockTxn.mock.calls[0][0].billingUserId).toBe('explicit-9');
      expect(mockTxn.mock.calls[1][0].billingUserId).toBe(OWNER);
    });
  });

  describe('it can never lose a record', () => {
    it("a resolver failure bills the acting user (the old behaviour), never throws, and logs", async () => {
      resolver.mockRejectedValue(new Error('dynamo unavailable'));

      await expect(recordVendorUsage(vendor())).resolves.toBeUndefined();

      // The record is still written, against the acting user.
      expect(mockTxn.mock.calls[0][0].billingUserId).toBe(MEMBER);
      expect(mockTxn.mock.calls[0][1].billingUserId).toBe(MEMBER);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not resolve the org billing owner'),
        'dynamo unavailable',
      );
    });

    it("a failure is not cached — the next call retries and succeeds", async () => {
      resolver.mockRejectedValueOnce(new Error('blip')).mockImplementation(async (id: string) => (id === MEMBER ? OWNER : id));

      await recordVendorUsage(vendor());
      await recordVendorUsage(vendor());

      expect(mockTxn.mock.calls[0][1].billingUserId).toBe(MEMBER); // during the blip
      expect(mockTxn.mock.calls[1][1].billingUserId).toBe(OWNER); // recovered
    });
  });

  describe('cost: it does not add a lookup to every call', () => {
    it("resolves a user once within the cache window", async () => {
      await recordVendorUsage(vendor());
      await recordVendorUsage(vendor({ operation: 'person_match' }));
      await recordUsage(llm());

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(mockTxn.mock.calls.map((c) => c[1].billingUserId)).toEqual([OWNER, OWNER, OWNER]);
    });
  });

  describe('reversible without a deploy', () => {
    it("SPEND_RECORDER_RESOLVE_ORG_OWNER=false restores billing the acting user", async () => {
      process.env[SPEND_RECORDER_RESOLVE_ORG_OWNER_ENV] = 'false';

      await recordVendorUsage(vendor());
      await recordUsage(llm());

      expect(mockTxn.mock.calls[0][1].billingUserId).toBe(MEMBER);
      expect(mockTxn.mock.calls[1][1].billingUserId).toBe(MEMBER);
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
