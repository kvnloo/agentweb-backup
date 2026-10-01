/**
 * ENG-TBD — seat-based billing, cap math only.
 *
 * Covers: the per-tier base lookup, the cap formula (including the `null` =
 * "unlimited" contract), and `assertSeatAvailable`'s boundary behavior —
 * most importantly the exact-at-cap case, since an off-by-one here either
 * lets in one too many members or blocks the last legitimate one.
 */

import {
  baseSeatsForTier,
  effectiveSeatCap,
  assertSeatAvailable,
  SeatLimitReachedError,
  SEAT_LIMIT_REACHED,
} from "../services/orgSeatService";
import { orgDb } from "../services/db";
import { getUserSubscriptionType } from "../services/subscriptionService";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn(), getOrgMemberCount: jest.fn() },
}));

jest.mock("../services/subscriptionService", () => ({
  getUserSubscriptionType: jest.fn(),
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockGetUserSubscriptionType = getUserSubscriptionType as jest.Mock;

const ORG_ID = "org-1";
const OWNER_ID = "owner-1";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("baseSeatsForTier", () => {
  it.each([
    ["Starter", 2],
    ["Pro", 5],
  ])("%s -> %d", (tier, expected) => {
    expect(baseSeatsForTier(tier)).toBe(expected);
  });

  it.each(["Free", "Managed", "Partner", "Super Premium", "Demo", "Sandbox", "Nonexistent"])(
    "%s -> null (no seat cap applies)",
    (tier) => {
      expect(baseSeatsForTier(tier)).toBeNull();
    }
  );

  it("is case-sensitive — a near-miss spelling is not silently accepted", () => {
    expect(baseSeatsForTier("pro")).toBeNull();
    expect(baseSeatsForTier("STARTER")).toBeNull();
  });
});

describe("effectiveSeatCap", () => {
  it("returns null (unlimited) when the tier has no base", () => {
    expect(effectiveSeatCap(null, 10)).toBeNull();
    expect(effectiveSeatCap(null, undefined)).toBeNull();
  });

  it("adds purchased extra seats onto the base", () => {
    expect(effectiveSeatCap(5, 3)).toBe(8);
    expect(effectiveSeatCap(2, 1)).toBe(3);
  });

  it.each([undefined, null, 0, -1, NaN])(
    "treats a missing/zero/negative/non-finite purchasedExtraSeats (%p) as 0, never subtracting from the base",
    (value) => {
      expect(effectiveSeatCap(5, value as any)).toBe(5);
    }
  );

  it("floors a fractional purchasedExtraSeats rather than over- or under-counting", () => {
    expect(effectiveSeatCap(2, 1.9)).toBe(3);
  });
});

describe("assertSeatAvailable", () => {
  function mockOrg(overrides: Partial<{ purchasedExtraSeats: number }> = {}) {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: ORG_ID,
      ownerUserId: OWNER_ID,
      ...overrides,
    } as any);
  }

  it("throws Organization not found when the org does not exist", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    await expect(assertSeatAvailable(ORG_ID)).rejects.toThrow(`Organization ${ORG_ID} not found`);
  });

  it("resolves (no cap) for a tier with no seat concept, regardless of headcount", async () => {
    mockOrg();
    mockGetUserSubscriptionType.mockResolvedValue("Managed");
    await expect(assertSeatAvailable(ORG_ID)).resolves.toBeUndefined();
    // No cap applies, so the member-count lookup should never even run.
    expect(mockOrgDb.getOrgMemberCount).not.toHaveBeenCalled();
  });

  it("allows admitting a member when below the cap (Pro, 4 of 5)", async () => {
    mockOrg();
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockOrgDb.getOrgMemberCount.mockResolvedValue(4);
    await expect(assertSeatAvailable(ORG_ID)).resolves.toBeUndefined();
  });

  it("blocks exactly at the cap (Pro, 5 of 5) — the critical boundary", async () => {
    mockOrg();
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockOrgDb.getOrgMemberCount.mockResolvedValue(5);
    await expect(assertSeatAvailable(ORG_ID)).rejects.toThrow(SeatLimitReachedError);
  });

  it("blocks above the cap (Pro, 6 of 5 — already overcapacity)", async () => {
    mockOrg();
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockOrgDb.getOrgMemberCount.mockResolvedValue(6);
    await expect(assertSeatAvailable(ORG_ID)).rejects.toThrow(SeatLimitReachedError);
  });

  it("raises the effective cap by purchasedExtraSeats (Starter base 2 + 1 purchased = 3)", async () => {
    mockOrg({ purchasedExtraSeats: 1 });
    mockGetUserSubscriptionType.mockResolvedValue("Starter");
    mockOrgDb.getOrgMemberCount.mockResolvedValue(2);
    await expect(assertSeatAvailable(ORG_ID)).resolves.toBeUndefined();

    mockOrgDb.getOrgMemberCount.mockResolvedValue(3);
    await expect(assertSeatAvailable(ORG_ID)).rejects.toThrow(SeatLimitReachedError);
  });

  it("the thrown error carries a machine-readable code and the cap/count that triggered it", async () => {
    mockOrg();
    mockGetUserSubscriptionType.mockResolvedValue("Starter");
    mockOrgDb.getOrgMemberCount.mockResolvedValue(2);

    await assertSeatAvailable(ORG_ID).catch((error) => {
      expect(error).toBeInstanceOf(SeatLimitReachedError);
      expect(error.code).toBe(SEAT_LIMIT_REACHED);
      expect(error.cap).toBe(2);
      expect(error.currentMemberCount).toBe(2);
      expect(error.orgId).toBe(ORG_ID);
    });
  });

  it("re-reads org and member count on every call rather than caching stale state", async () => {
    mockOrg();
    mockGetUserSubscriptionType.mockResolvedValue("Pro");
    mockOrgDb.getOrgMemberCount.mockResolvedValue(4);
    await assertSeatAvailable(ORG_ID);
    await assertSeatAvailable(ORG_ID);
    expect(mockOrgDb.getOrgById).toHaveBeenCalledTimes(2);
    expect(mockOrgDb.getOrgMemberCount).toHaveBeenCalledTimes(2);
  });
});
