/**
 * ENG-1250 §9.6 — the dark enforcement cutover switch.
 *
 * Billing-critical invariant (which paid calls get blocked), so this suite is
 * retained: it pins that the switch is dark by default, reversible, canary-able,
 * and fails OPEN to the legacy figure on any missing/failed ledger read.
 */
import type { PersistedProjection } from "../services/spendProjectionDb";

const getProjectionMock = jest.fn();
jest.mock("../services/spendProjectionDb", () => ({
  getProjection: (...args: unknown[]) => getProjectionMock(...args),
}));

import {
  isSpendLedgerEnforcementEnabled,
  resolveEnforcementCostBasisMicroUsd,
  SPEND_LEDGER_ENFORCEMENT_ENV,
  SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV,
  SPEND_PROJECTION_MAX_STALENESS_MIN_ENV,
} from "../services/spendEnforcementBasis";

const ACCT = "bb07579b-2d82-4d45-894f-ec74ec7e78c2";
const MONTH = "2026-09";

/** A persisted projection whose settled all-vendor total is `settledMicroUsd`. */
function projection(settledMicroUsd: number, computedAt = "2026-09-17T00:00:00.000Z"): PersistedProjection {
  return {
    billingUserId: ACCT,
    billingMonth: MONTH,
    settledMicroUsd,
    reservedMicroUsd: 0,
    includedAllowanceMicroUsd: 150_000_000,
    purchasedCreditsMicroUsd: 0,
    adminAdjustmentMicroUsd: 0,
    migrationAdjustmentMicroUsd: 0,
    usableAllowanceMicroUsd: 150_000_000,
    remainingMicroUsd: 0,
    overspentMicroUsd: 0,
    unlimited: false,
    policyMode: "full_choice",
    settledEventCount: 1,
    reservedEventCount: 0,
    voidedEventCount: 0,
    excludedEventCount: 0,
    computedAt,
    availableMicroUsd: 0,
  };
}

describe("spendEnforcementBasis", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    getProjectionMock.mockReset();
    delete process.env[SPEND_LEDGER_ENFORCEMENT_ENV];
    delete process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV];
    delete process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV];
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe("isSpendLedgerEnforcementEnabled", () => {
    it("is dark (false) when the env var is unset", () => {
      expect(isSpendLedgerEnforcementEnabled(ACCT)).toBe(false);
    });

    it("is dark for 'legacy', 'false', and unrecognised values", () => {
      for (const v of ["legacy", "false", "", "off", "1", "yes"]) {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = v;
        expect(isSpendLedgerEnforcementEnabled(ACCT)).toBe(false);
      }
    });

    it("is enabled globally for 'true' (case/space-insensitive)", () => {
      for (const v of ["true", "TRUE", "  true  "]) {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = v;
        expect(isSpendLedgerEnforcementEnabled(ACCT)).toBe(true);
      }
    });

    it("in 'allowlist' mode enables only listed accounts", () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "allowlist";
      process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] = ` other-acct , ${ACCT} `;
      expect(isSpendLedgerEnforcementEnabled(ACCT)).toBe(true);
      expect(isSpendLedgerEnforcementEnabled("someone-else")).toBe(false);
    });

    it("in 'allowlist' mode with an empty list enables nobody", () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "allowlist";
      expect(isSpendLedgerEnforcementEnabled(ACCT)).toBe(false);
    });
  });

  describe("resolveEnforcementCostBasisMicroUsd", () => {
    it("returns the legacy figure and never reads the ledger when dark", async () => {
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res).toEqual({ rawCostUsedMicroUsd: 115_740_000, basis: "legacy", projectionMissing: false, stale: false });
      expect(getProjectionMock).not.toHaveBeenCalled();
    });

    it("replaces the basis with the ledger's settled all-vendor total when enabled", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      // llm-only legacy = $115.74; ledger settled (llm+vendor) = $218.24.
      getProjectionMock.mockResolvedValue(projection(218_240_000));
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res).toEqual({ rawCostUsedMicroUsd: 218_240_000, basis: "spend_ledger", projectionMissing: false, stale: false });
      expect(getProjectionMock).toHaveBeenCalledWith(ACCT, MONTH);
    });

    it("fails OPEN to the legacy figure when no projection is persisted", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      getProjectionMock.mockResolvedValue(null);
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res).toEqual({ rawCostUsedMicroUsd: 115_740_000, basis: "legacy", projectionMissing: true, stale: false });
    });

    it("fails OPEN to the legacy figure when the ledger read throws", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      getProjectionMock.mockRejectedValue(new Error("dynamo unavailable"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res).toEqual({ rawCostUsedMicroUsd: 115_740_000, basis: "legacy", projectionMissing: true, stale: false });
      errSpy.mockRestore();
    });

    it("reads the ledger only for allowlisted accounts", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "allowlist";
      process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] = ACCT;
      getProjectionMock.mockResolvedValue(projection(218_240_000));

      const listed = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(listed.basis).toBe("spend_ledger");

      const other = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: "not-on-list",
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 1,
      });
      expect(other.basis).toBe("legacy");
      expect(getProjectionMock).toHaveBeenCalledTimes(1);
      expect(getProjectionMock).toHaveBeenCalledWith(ACCT, MONTH);
    });

    it("floors a negative settled total at zero and rounds to an integer micro-USD", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      getProjectionMock.mockResolvedValueOnce(projection(-5));
      const neg = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 10,
      });
      expect(neg.rawCostUsedMicroUsd).toBe(0);

      getProjectionMock.mockResolvedValueOnce(projection(100.6));
      const frac = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 10,
      });
      expect(frac.rawCostUsedMicroUsd).toBe(101);
    });
  });

  describe("month rollover (Gate 3)", () => {
    // The projection is keyed by (billingUserId, billingMonth). Enforcement must
    // read the CURRENT month's row, so last month's over-cap settled can never
    // carry into a fresh month — it either reads this month's (fresh/low) row or,
    // before the writer has created it, fails open to legacy (which also resets
    // monthly). This pins the month-keying that makes rollover correct.
    it("queries the projection for the exact billingMonth passed", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      getProjectionMock.mockResolvedValue(projection(10_000_000));
      await resolveEnforcementCostBasisMicroUsd({ billingUserId: ACCT, billingMonth: "2026-10", legacyRawCostUsedMicroUsd: 0 });
      expect(getProjectionMock).toHaveBeenCalledWith(ACCT, "2026-10");
    });

    it("does not let last month's over-cap row leak into the new month", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      // A row exists ONLY for 2026-09 (over cap); the new month 2026-10 has none yet.
      getProjectionMock.mockImplementation(async (_id: string, month: string) =>
        month === "2026-09" ? projection(500_000_000) : null,
      );

      const lastMonth = await resolveEnforcementCostBasisMicroUsd({ billingUserId: ACCT, billingMonth: "2026-09", legacyRawCostUsedMicroUsd: 0 });
      expect(lastMonth.basis).toBe("spend_ledger");
      expect(lastMonth.rawCostUsedMicroUsd).toBe(500_000_000);

      // New month: no row yet → fails open to legacy (fresh), NOT the $500 over-cap total.
      const newMonth = await resolveEnforcementCostBasisMicroUsd({ billingUserId: ACCT, billingMonth: "2026-10", legacyRawCostUsedMicroUsd: 0 });
      expect(newMonth.basis).toBe("legacy");
      expect(newMonth.projectionMissing).toBe(true);
      expect(newMonth.rawCostUsedMicroUsd).toBe(0);
    });
  });

  describe("computedAt staleness guard", () => {
    it("is disabled by default: an ancient snapshot is still used when no threshold is set", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      getProjectionMock.mockResolvedValue(projection(218_240_000, "2000-01-01T00:00:00.000Z"));
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res.basis).toBe("spend_ledger");
      expect(res.stale).toBe(false);
    });

    it("fails OPEN to legacy when the snapshot is older than the threshold", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV] = "60";
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const old = new Date(Date.now() - 120 * 60_000).toISOString(); // 2h old
      getProjectionMock.mockResolvedValue(projection(218_240_000, old));
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res).toEqual({ rawCostUsedMicroUsd: 115_740_000, basis: "legacy", projectionMissing: false, stale: true });
      warn.mockRestore();
    });

    it("uses the ledger basis when the snapshot is within the threshold", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV] = "60";
      const fresh = new Date(Date.now() - 5 * 60_000).toISOString(); // 5m old
      getProjectionMock.mockResolvedValue(projection(218_240_000, fresh));
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res.basis).toBe("spend_ledger");
      expect(res.stale).toBe(false);
    });

    it("treats a missing/unparseable computedAt as stale when the guard is on", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV] = "60";
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      getProjectionMock.mockResolvedValue(projection(218_240_000, "not-a-date"));
      const res = await resolveEnforcementCostBasisMicroUsd({
        billingUserId: ACCT,
        billingMonth: MONTH,
        legacyRawCostUsedMicroUsd: 115_740_000,
      });
      expect(res.basis).toBe("legacy");
      expect(res.stale).toBe(true);
      warn.mockRestore();
    });
  });
});
