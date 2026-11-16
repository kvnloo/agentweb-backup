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
  SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV,
  SPEND_PROJECTION_MAX_STALENESS_MIN_ENV,
  __resetMissingProjectionLogForTests,
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
    delete process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV];
    delete process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV];
    __resetMissingProjectionLogForTests();
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

    describe("tier exclusion (broad flip that skips Free)", () => {
      it("keeps an excluded tier on legacy even under '=true' (case-insensitive)", () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV] = "Free";
        expect(isSpendLedgerEnforcementEnabled(ACCT, "Free")).toBe(false);
        expect(isSpendLedgerEnforcementEnabled(ACCT, "free")).toBe(false);
        expect(isSpendLedgerEnforcementEnabled(ACCT, "  FREE ")).toBe(false);
      });

      it("still enforces non-excluded (paid) tiers under '=true'", () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV] = "Free";
        for (const tier of ["Starter", "Pro", "Super Premium"]) {
          expect(isSpendLedgerEnforcementEnabled(ACCT, tier)).toBe(true);
        }
      });

      it("supports a multi-tier exclusion list", () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV] = "Free, Trial";
        expect(isSpendLedgerEnforcementEnabled(ACCT, "Trial")).toBe(false);
        expect(isSpendLedgerEnforcementEnabled(ACCT, "Pro")).toBe(true);
      });

      it("has no effect when the exclusion list is empty/unset", () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        expect(isSpendLedgerEnforcementEnabled(ACCT, "Free")).toBe(true);
      });

      it("does not resurrect a disabled mode — an excluded tier under legacy stays false", () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV] = "Free";
        expect(isSpendLedgerEnforcementEnabled(ACCT, "Pro")).toBe(false); // mode dark
      });

      it("resolveEnforcementCostBasisMicroUsd honors the excluded tier (Free stays on legacy)", async () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        process.env[SPEND_LEDGER_ENFORCEMENT_EXCLUDE_TIERS_ENV] = "Free";
        getProjectionMock.mockResolvedValue(projection(999_000_000));
        const res = await resolveEnforcementCostBasisMicroUsd({
          billingUserId: ACCT,
          billingMonth: MONTH,
          legacyRawCostUsedMicroUsd: 4_420_000,
          tier: "Free",
        });
        expect(res.basis).toBe("legacy");
        expect(res.rawCostUsedMicroUsd).toBe(4_420_000);
        expect(getProjectionMock).not.toHaveBeenCalled();
      });
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

    describe("ledger basis never falls back to the legacy counter (ENG-1250 AC7)", () => {
      const input = { billingUserId: ACCT, billingMonth: MONTH, legacyRawCostUsedMicroUsd: 115_740_000 };

      it("a MISSING projection counts as $0 spend — never the legacy figure", async () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        getProjectionMock.mockResolvedValue(null);
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

        const res = await resolveEnforcementCostBasisMicroUsd(input);

        expect(res).toEqual({ rawCostUsedMicroUsd: 0, basis: "spend_ledger", projectionMissing: true, stale: false });
        logSpy.mockRestore();
      });

      it("logs a missing projection once per subject+month, not on every request", async () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        getProjectionMock.mockResolvedValue(null);
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

        await resolveEnforcementCostBasisMicroUsd(input);
        await resolveEnforcementCostBasisMicroUsd(input);
        await resolveEnforcementCostBasisMicroUsd({ ...input, billingMonth: "2026-10" });

        const lines = logSpy.mock.calls.filter((c) => String(c[0]).includes("no projection yet"));
        expect(lines).toHaveLength(2); // one per distinct subject+month
        logSpy.mockRestore();
      });

      it("a read ERROR fails OPEN: counts $0, admits, and logs loudly", async () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        getProjectionMock.mockRejectedValue(new Error("dynamo unavailable"));
        const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        const res = await resolveEnforcementCostBasisMicroUsd(input);

        expect(res).toEqual({ rawCostUsedMicroUsd: 0, basis: "spend_ledger", projectionMissing: true, stale: false });
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("failing OPEN"), expect.any(Error));
        errSpy.mockRestore();
      });

      it("a projection that EXISTS is still used exactly as before", async () => {
        process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
        getProjectionMock.mockResolvedValue(projection(218_240_000));
        const res = await resolveEnforcementCostBasisMicroUsd(input);
        expect(res).toEqual({ rawCostUsedMicroUsd: 218_240_000, basis: "spend_ledger", projectionMissing: false, stale: false });
      });
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

      // New month: no row yet → counts $0 (a fresh month), NOT the $500 over-cap total.
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      const newMonth = await resolveEnforcementCostBasisMicroUsd({ billingUserId: ACCT, billingMonth: "2026-10", legacyRawCostUsedMicroUsd: 0 });
      logSpy.mockRestore();
      expect(newMonth.basis).toBe("spend_ledger");
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
  // ENG-1250 AC7: the legacy counter is retiring, so it must not be read unless a legacy path is
  // actually taken. Passing a function makes that observable.
  describe("lazy legacy counter (never read on the live ledger path)", () => {
    const base = { billingUserId: ACCT, billingMonth: MONTH };

    it("is NOT invoked when the ledger basis is used", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] = "*";
      getProjectionMock.mockResolvedValue(projection(5_000_000));
      const legacy = jest.fn().mockResolvedValue(999);

      const res = await resolveEnforcementCostBasisMicroUsd({ ...base, legacyRawCostUsedMicroUsd: legacy });

      expect(res).toMatchObject({ basis: "spend_ledger", rawCostUsedMicroUsd: 5_000_000 });
      expect(legacy).not.toHaveBeenCalled();
    });

    it("is NOT invoked when the projection is missing or the read fails (counts $0 / fails open)", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] = "*";
      const legacy = jest.fn().mockResolvedValue(999);
      jest.spyOn(console, "log").mockImplementation(() => {});
      jest.spyOn(console, "error").mockImplementation(() => {});

      getProjectionMock.mockResolvedValueOnce(null);
      expect((await resolveEnforcementCostBasisMicroUsd({ ...base, legacyRawCostUsedMicroUsd: legacy })).rawCostUsedMicroUsd).toBe(0);
      getProjectionMock.mockRejectedValueOnce(new Error("boom"));
      expect((await resolveEnforcementCostBasisMicroUsd({ ...base, legacyRawCostUsedMicroUsd: legacy })).rawCostUsedMicroUsd).toBe(0);

      expect(legacy).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it("IS invoked (and its value used) when enforcement is off for the subject", async () => {
      const legacy = jest.fn().mockResolvedValue(7_000_000);

      const res = await resolveEnforcementCostBasisMicroUsd({ ...base, legacyRawCostUsedMicroUsd: legacy });

      expect(res).toMatchObject({ basis: "legacy", rawCostUsedMicroUsd: 7_000_000 });
      expect(legacy).toHaveBeenCalledTimes(1);
    });


    it("IS invoked on the staleness fallback", async () => {
      process.env[SPEND_LEDGER_ENFORCEMENT_ENV] = "true";
      process.env[SPEND_LEDGER_ENFORCEMENT_ACCOUNTS_ENV] = "*";
      process.env[SPEND_PROJECTION_MAX_STALENESS_MIN_ENV] = "5";
      jest.spyOn(console, "warn").mockImplementation(() => {});
      getProjectionMock.mockResolvedValue(projection(218_240_000, "2020-01-01T00:00:00.000Z"));
      const legacy = jest.fn().mockResolvedValue(4_000_000);

      const res = await resolveEnforcementCostBasisMicroUsd({ ...base, legacyRawCostUsedMicroUsd: legacy });

      expect(res).toMatchObject({ basis: "legacy", stale: true, rawCostUsedMicroUsd: 4_000_000 });
      expect(legacy).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
    });
  });
});
