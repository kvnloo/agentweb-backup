/**
 * ENG-2247 — seat-based billing, Phase 3: monthly LLM usage credit grant.
 *
 * These tests exercise the REAL `grantMonthlyLlmUsageCredit` (not mocked) by
 * spying on `orgDb.listAll` / `userDb.getUserById` / `userDb.updateUser` the
 * same way `llmUsageCreditService.test.ts` spies on `userDb` for its own
 * admin/purchase-grant tests — the in-memory `users` map below stands in for
 * DynamoDB, so idempotency here is proven against the actual grantId ledger
 * logic, not a reimplementation of it.
 *
 * The reconciliation test is the single most important assertion in this
 * file: a silent double-grant or missed grant here is a real money bug.
 *
 * The `updateUser` fake below deliberately evaluates `options.condition`
 * against the live `users` table at write time and throws a
 * `ConditionalCheckFailedException`-shaped error on mismatch, the same way
 * real DynamoDB does. An earlier version of this fake applied `updates`
 * unconditionally, which made every "idempotency" test here pass even though
 * it never actually exercised `grantMonthlyLlmUsageCredit`'s optimistic-
 * concurrency retry loop — the one piece of code that is actually
 * responsible for collapsing two concurrent grant attempts (e.g. two cron
 * instances, or a deploy restarting mid-sweep) into a single grant. The
 * concurrency test below depends on this fidelity.
 */
import { orgDb, userDb } from '../services/db';
import {
  grantMonthlySeatCreditForOrg,
  grantMonthlySeatCreditsForAllOrgs,
  seatCreditGrantId,
  SEAT_CREDIT_MICRO_USD_PER_SEAT,
} from '../services/orgSeatCreditGrantService';

type FakeUser = { userId: string; email: string; llmUsageCredits?: any };

/** Mirrors the handful of ConditionExpression shapes `grantMonthlyLlmUsageCredit`
 * actually issues against the (non-admin) `userDb.updateUser` path, evaluated
 * against the live fake table — not the caller's stale read — exactly like
 * DynamoDB evaluates a real ConditionExpression at write time. */
function conditionHolds(
  condition: { expression: string; names?: Record<string, string>; values?: Record<string, any> } | undefined,
  stored: FakeUser | undefined,
): boolean {
  if (!condition) return true;
  const ledger = stored?.llmUsageCredits;
  if (condition.expression === 'attribute_not_exists(#creditLedger)') {
    return !ledger;
  }
  if (condition.expression === '#creditLedger.#version = :expectedVersion') {
    return ledger?.version === condition.values?.[':expectedVersion'];
  }
  if (condition.expression.includes('attribute_not_exists(#creditLedger.#version)')) {
    return (
      ledger?.version == null &&
      ledger?.month === condition.values?.[':expectedMonth'] &&
      JSON.stringify(ledger?.grantIds || []) === JSON.stringify(condition.values?.[':expectedGrantIds'] || [])
    );
  }
  throw new Error(`orgSeatCreditGrantService.test.ts fake does not model condition: ${condition.expression}`);
}

describe('orgSeatCreditGrantService', () => {
  let users: Record<string, FakeUser>;
  let getUserByIdSpy: jest.SpyInstance;
  let updateUserSpy: jest.SpyInstance;
  let listAllSpy: jest.SpyInstance;

  beforeEach(() => {
    users = {};
    getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockImplementation(async (userId: string) => users[userId]);
    updateUserSpy = jest.spyOn(userDb, 'updateUser').mockImplementation(async (userId: string, updates: any, options?: any) => {
      // A microtask tick between the condition check and the write, modeling
      // the real read-then-write gap `grantMonthlyLlmUsageCredit` has between
      // its `userDb.getUserById` read and this `updateUser` call — enough for
      // two concurrent callers to genuinely interleave in the tests below.
      await Promise.resolve();
      if (!conditionHolds(options?.condition, users[userId])) {
        const err: any = new Error('The conditional request failed');
        err.code = 'ConditionalCheckFailedException';
        throw err;
      }
      users[userId] = { ...users[userId], ...updates } as FakeUser;
      return users[userId] as any;
    });
    listAllSpy = jest.spyOn(orgDb, 'listAll');
  });

  afterEach(() => {
    getUserByIdSpy.mockRestore();
    updateUserSpy.mockRestore();
    listAllSpy.mockRestore();
  });

  function seedOwner(userId: string) {
    users[userId] = { userId, email: `${userId}@agentweb.pro` };
  }

  const NOW = new Date('2026-10-01T00:00:00.000Z');
  const USAGE_MONTH = '2026-10';

  describe('reconciliation', () => {
    it('credits exactly 30_000_000 micro-USD per purchased seat, summed across every org', async () => {
      const orgs = [
        { orgId: 'org-zero', ownerUserId: 'owner-zero', purchasedExtraSeats: 0 },
        { orgId: 'org-absent', ownerUserId: 'owner-absent' }, // field entirely absent
        { orgId: 'org-one', ownerUserId: 'owner-one', purchasedExtraSeats: 1 },
        { orgId: 'org-seven', ownerUserId: 'owner-seven', purchasedExtraSeats: 7 },
      ] as any[];
      orgs.forEach((o) => seedOwner(o.ownerUserId));
      listAllSpy.mockResolvedValue(orgs);

      const summary = await grantMonthlySeatCreditsForAllOrgs(NOW);

      expect(summary.scanned).toBe(4);
      expect(summary.eligible).toBe(2);
      expect(summary.granted).toBe(2);
      expect(summary.idempotent).toBe(0);
      expect(summary.failed).toBe(0);

      // The load-bearing assertion: total credited == 30_000_000 * sum(purchasedExtraSeats).
      const expectedTotal = SEAT_CREDIT_MICRO_USD_PER_SEAT * (0 + 0 + 1 + 7);
      expect(summary.totalGrantedMicroUsd).toBe(expectedTotal);

      // Cross-check against what actually landed on each user's ledger —
      // the summary must not just claim the right number, the money must
      // actually be there.
      const actualTotal = Object.values(users).reduce(
        (sum, u) => sum + (u.llmUsageCredits?.totalPurchasedMicroUsd || 0),
        0,
      );
      expect(actualTotal).toBe(expectedTotal);

      expect(users['owner-zero'].llmUsageCredits).toBeUndefined();
      expect(users['owner-absent'].llmUsageCredits).toBeUndefined();
      expect(users['owner-one'].llmUsageCredits.totalPurchasedMicroUsd).toBe(30_000_000);
      expect(users['owner-seven'].llmUsageCredits.totalPurchasedMicroUsd).toBe(210_000_000);
    });

    it('skips orgs with no purchased seats without ever calling the credit grant (no wasted/zero calls)', async () => {
      const orgs = [
        { orgId: 'org-zero', ownerUserId: 'owner-zero', purchasedExtraSeats: 0 },
        { orgId: 'org-absent', ownerUserId: 'owner-absent' },
        { orgId: 'org-negative', ownerUserId: 'owner-negative', purchasedExtraSeats: -3 },
      ] as any[];
      orgs.forEach((o) => seedOwner(o.ownerUserId));
      listAllSpy.mockResolvedValue(orgs);

      const summary = await grantMonthlySeatCreditsForAllOrgs(NOW);

      expect(summary.eligible).toBe(0);
      expect(summary.granted).toBe(0);
      expect(summary.totalGrantedMicroUsd).toBe(0);
      expect(updateUserSpy).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('does not double-grant when the sweep runs twice for the same org/month', async () => {
      const org = { orgId: 'org-dup', ownerUserId: 'owner-dup', purchasedExtraSeats: 3 } as any;
      seedOwner(org.ownerUserId);
      listAllSpy.mockResolvedValue([org]);

      const first = await grantMonthlySeatCreditsForAllOrgs(NOW);
      expect(first.granted).toBe(1);
      expect(first.idempotent).toBe(0);
      expect(first.totalGrantedMicroUsd).toBe(90_000_000);

      const second = await grantMonthlySeatCreditsForAllOrgs(NOW);
      expect(second.granted).toBe(0);
      expect(second.idempotent).toBe(1);
      expect(second.totalGrantedMicroUsd).toBe(0);

      // The ledger must still reflect exactly one grant, not two.
      expect(users['owner-dup'].llmUsageCredits.totalPurchasedMicroUsd).toBe(90_000_000);
      expect(users['owner-dup'].llmUsageCredits.grantIds).toEqual([
        seatCreditGrantId('org-dup', USAGE_MONTH),
      ]);
      // The second run's early grantId check inside grantMonthlyLlmUsageCredit
      // must short-circuit before ever writing again.
      expect(updateUserSpy).toHaveBeenCalledTimes(1);
    });

    it('a single org-level grant call is idempotent by grantId directly', async () => {
      const org = { orgId: 'org-direct', ownerUserId: 'owner-direct', purchasedExtraSeats: 2 } as any;
      seedOwner(org.ownerUserId);

      const first = await grantMonthlySeatCreditForOrg(org, NOW);
      expect(first).toEqual({ orgId: 'org-direct', attempted: true, granted: true, amountMicroUsd: 60_000_000 });

      const second = await grantMonthlySeatCreditForOrg(org, NOW);
      expect(second).toEqual({ orgId: 'org-direct', attempted: true, granted: false, amountMicroUsd: 60_000_000 });

      expect(users['owner-direct'].llmUsageCredits.totalPurchasedMicroUsd).toBe(60_000_000);
      expect(updateUserSpy).toHaveBeenCalledTimes(1);
    });

    it('does not double-grant when two sweeps race concurrently for the same org/month (simulates two cron-bearing instances firing at once, or a deploy restarting mid-sweep)', async () => {
      const org = { orgId: 'org-race', ownerUserId: 'owner-race', purchasedExtraSeats: 3 } as any;
      seedOwner(org.ownerUserId);
      listAllSpy.mockResolvedValue([org]);

      const [summaryA, summaryB] = await Promise.all([
        grantMonthlySeatCreditsForAllOrgs(NOW),
        grantMonthlySeatCreditsForAllOrgs(NOW),
      ]);

      // Exactly one of the two concurrent sweeps may have actually granted;
      // the loser must observe the DynamoDB-level ConditionalCheckFailedException,
      // retry, see the grantId already present, and report idempotent instead.
      expect(summaryA.granted + summaryB.granted).toBe(1);
      expect(summaryA.idempotent + summaryB.idempotent).toBe(1);
      expect(summaryA.failed).toBe(0);
      expect(summaryB.failed).toBe(0);
      expect(summaryA.totalGrantedMicroUsd + summaryB.totalGrantedMicroUsd).toBe(90_000_000);

      // The ledger itself must reflect exactly one grant, not two.
      expect(users['owner-race'].llmUsageCredits.totalPurchasedMicroUsd).toBe(90_000_000);
      expect(users['owner-race'].llmUsageCredits.grantIds).toEqual([
        seatCreditGrantId('org-race', USAGE_MONTH),
      ]);
    });
  });

  describe('failure isolation', () => {
    it('continues past an org whose owner user record is missing and still grants the other orgs', async () => {
      const orgs = [
        { orgId: 'org-ghost', ownerUserId: 'owner-deleted-long-ago', purchasedExtraSeats: 5 },
        { orgId: 'org-fine', ownerUserId: 'owner-fine', purchasedExtraSeats: 2 },
      ] as any[];
      // Deliberately do NOT seed 'owner-deleted-long-ago' — models a missing/deleted
      // owner record so userDb.getUserById returns undefined and
      // grantMonthlyLlmUsageCredit throws "User not found".
      seedOwner('owner-fine');
      listAllSpy.mockResolvedValue(orgs);

      const summary = await grantMonthlySeatCreditsForAllOrgs(NOW);

      expect(summary.scanned).toBe(2);
      expect(summary.eligible).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.errors).toEqual([
        expect.objectContaining({ orgId: 'org-ghost', error: expect.stringContaining('User not found') }),
      ]);

      // The batch must not have aborted — the org after the failing one still
      // got its grant.
      expect(summary.granted).toBe(1);
      expect(summary.totalGrantedMicroUsd).toBe(60_000_000);
      expect(users['owner-fine'].llmUsageCredits.totalPurchasedMicroUsd).toBe(60_000_000);
    });
  });

  describe('fractional purchasedExtraSeats', () => {
    it('treats a seat count that floors to zero as fully ineligible — no call, no phantom eligible count', async () => {
      const org = { orgId: 'org-fractional', ownerUserId: 'owner-fractional', purchasedExtraSeats: 0.5 } as any;
      seedOwner(org.ownerUserId);
      listAllSpy.mockResolvedValue([org]);

      const summary = await grantMonthlySeatCreditsForAllOrgs(NOW);

      // Must not be counted eligible if it can never be granted/idempotent/failed —
      // eligible must always equal granted + idempotent + failed.
      expect(summary.eligible).toBe(0);
      expect(summary.granted).toBe(0);
      expect(summary.idempotent).toBe(0);
      expect(summary.failed).toBe(0);
      expect(updateUserSpy).not.toHaveBeenCalled();
      expect(users['owner-fractional'].llmUsageCredits).toBeUndefined();
    });
  });
});
