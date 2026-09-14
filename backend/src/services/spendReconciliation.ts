/**
 * The internal reconciliation of ENG-1250 §8, and the evidence AC6 asks for.
 *
 * §8 wants two independent checks. This module builds the INTERNAL one; the
 * external check (vendor invoice or usage export against attributed totals)
 * needs invoice data we do not hold and is separate work.
 *
 * The internal check is really two different questions that must not be
 * conflated, because they have opposite expected answers:
 *
 *  1. FIDELITY — does the shadow ledger faithfully reproduce the vendor rows
 *     the live rail already writes? Expected drift: ZERO. Anything else means
 *     the mirror is losing, duplicating or mispricing events, and no
 *     conclusion drawn from this data is safe until it is zero.
 *
 *  2. BASIS DIVERGENCE — how much larger is all-vendor spend than the LLM-only
 *     figure the live gate enforces on? Expected drift: NON-ZERO, and
 *     quantifying it is the entire point. This is the number AC6 is waiting
 *     for: how much sooner an account would hit its cap if enforcement moved
 *     to this rail.
 *
 * Reporting one number for both would be useless. A large total could mean the
 * mirror is broken (stop everything) or that vendors are simply a large share
 * of spend (the expected finding), and those demand opposite responses.
 *
 * Pure functions over rows fetched by the caller: no new persistence, nothing
 * scheduled, and nothing that can move enforcement. AC6 keeps that with Harsha.
 */
import { SpendEvent } from "./spendEventDb";
import { UsageRecordRow, isVendorEntry } from "./usageRecordDb";
import { LLM_SPEND_LEDGER_STARTED_ON, isLlmDualWriteEnabled, isLlmSpendEvent } from "./spendLedgerDualWrite";

/**
 * §8: "Drift above one cent or the vendor-specific threshold alerts."
 * One cent is 10,000 micro-dollars.
 */
export const DRIFT_TOLERANCE_MICRO_USD = 10_000;

/**
 * The provider slot every LLM group is reported under (ENG-1934).
 *
 * LLM groups are keyed on (date, model) rather than (date, provider, model):
 * aggregate rows written before ENG-693 carry no provider, and a model id is
 * already unique across providers, so keying on provider too would split one
 * model's spend into a matched half and a spurious unmirrored half.
 */
export const LLM_GROUP_PROVIDER = "llm";

/** One vendor's — or one LLM model's — slice of one day, on both rails. */
export interface FidelityGroup {
  /** Which rail the group belongs to; each has its own mirror start day. */
  rail: "vendor" | "llm";
  date: string;
  provider: string;
  operation: string;
  ledgerMicroUsd: number;
  liveMicroUsd: number;
  driftMicroUsd: number;
  ledgerEventCount: number;
  /** The live rail aggregates per day, so this is its own call counter. */
  liveCallCount: number;
  ok: boolean;
}

export interface FidelityReport {
  ok: boolean;
  /** Over ASSESSED groups only — excludes pre-mirror history and the changeover day. */
  ledgerMicroUsd: number;
  /** Over ASSESSED groups only. */
  liveMicroUsd: number;
  driftMicroUsd: number;
  /** Only the groups that failed, so a clean run has nothing to read. */
  driftingGroups: FidelityGroup[];
  /**
   * Live vendor spend with no shadow event at all. §8: "A successful vendor
   * call without a settled/voided event is an operational error." Separate from
   * ordinary drift because it means the mirror did not run, not that it
   * disagreed.
   */
  unmirroredGroups: FidelityGroup[];
  /**
   * Shadow events with no live row behind them — the inverse error, and the
   * more alarming one. The shadow leading the live rail is exactly what the
   * ordering fix in ENG-1804 exists to prevent, so anything here means that
   * guarantee has regressed.
   */
  orphanGroups: FidelityGroup[];
  /** Days wholly before the mirror existed. Excluded from the verdict. */
  preMirrorGroups: FidelityGroup[];
  /** The changeover day, which spans both sides of the deploy. Excluded too. */
  partialGroups: FidelityGroup[];
  groupCount: number;
  /**
   * Groups the verdict is actually based on. Zero means nothing was checked --
   * `ok` is then vacuously true and must not be read as evidence of anything.
   */
  assessedGroupCount: number;
}

const keyOf = (date: string, provider: string, operation: string) => `${date} ${provider} ${operation}`;

/**
 * The live rail namespaces a vendor row's `model` slot as
 * `{provider}:{operation}` (ENG-693). Split on the FIRST colon only: an
 * operation may legitimately contain one, a provider never does.
 */
export function splitVendorModel(model: string): { provider: string; operation: string } {
  const at = model.indexOf(":");
  return at < 0
    ? { provider: model, operation: "" }
    : { provider: model.slice(0, at), operation: model.slice(at + 1) };
}

/**
 * Check 1 — does the shadow reproduce the live vendor rows?
 *
 * Compared per (date, provider, operation) rather than as one total. A single
 * total nets a $5 overcount on one vendor against a $5 undercount on another
 * and reports zero, which is the one answer that would wrongly clear this rail
 * for enforcement.
 *
 * Only `settled` events count: a reservation is not spend, and a void is
 * explicitly not spend.
 */
export interface FidelityOptions {
  /**
   * When the dual-write actually began, as an ISO instant.
   *
   * Without it every row that predates the mirror reads as "not mirrored" and
   * fidelity can never go green -- the check would be permanently red for
   * history it was never meant to cover, which makes it useless as the AC6
   * precondition it exists to be.
   *
   * The live rail aggregates per DAY, so the day the mirror started cannot be
   * split: its row legitimately holds calls from both before and after. That
   * day is reported as PARTIAL and excluded from the verdict rather than
   * counted as a failure, and full days before it are dropped entirely.
   */
  mirrorStartedAt?: string;
  /**
   * ENG-1934: when LLM events began reaching the ledger, as an ISO instant.
   *
   * Absent, LLM spend is left out on BOTH sides — events and aggregate rows —
   * exactly as before LLM events existed. Present, LLM groups are assessed
   * from this day on, with the same pre-mirror and changeover-day rules the
   * vendor rail uses. Separate from `mirrorStartedAt` because the two rails
   * started months apart.
   */
  llmMirrorStartedAt?: string;
}

/**
 * An LLM aggregate row the ledger is not supposed to hold.
 *
 * An unpriced model writes an aggregate row but never a spend event (the
 * ledger forbids a missing rate as a silent $0). Counting those rows would
 * report every unknown model as unmirrored spend that was never spend.
 *
 * Trusts the row's own label and nothing else. Inferring "unpriced" from a $0
 * cost would discard a legitimately allocated $0 call — which DOES have an
 * event — and turn it into an orphan (CodeRabbit, PR #2904). The engine path
 * that used to mislabel unknown models `allocated` now labels them correctly.
 */
function isUnpricedLlmRow(row: UsageRecordRow): boolean {
  return row.costSource === "unpriced";
}

export function reconcileVendorFidelity(
  events: readonly SpendEvent[],
  liveRows: readonly UsageRecordRow[],
  options: FidelityOptions = {},
): FidelityReport {
  const mirrorStartDay = options.mirrorStartedAt?.slice(0, 10);
  const llmStartDay = options.llmMirrorStartedAt?.slice(0, 10);
  const groups = new Map<string, FidelityGroup>();

  const groupFor = (
    date: string,
    provider: string,
    operation: string,
    rail: FidelityGroup["rail"] = "vendor",
  ): FidelityGroup => {
    const key = `${rail} ${keyOf(date, provider, operation)}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        rail,
        date,
        provider,
        operation,
        ledgerMicroUsd: 0,
        liveMicroUsd: 0,
        driftMicroUsd: 0,
        ledgerEventCount: 0,
        liveCallCount: 0,
        ok: true,
      };
      groups.set(key, group);
    }
    return group;
  };

  for (const event of events) {
    if (event.lifecycle !== "settled") continue;
    const llm = isLlmSpendEvent(event);
    if (llm && !llmStartDay) continue;
    const group = llm
      ? groupFor(event.occurredAt.slice(0, 10), LLM_GROUP_PROVIDER, event.operation, "llm")
      : groupFor(event.occurredAt.slice(0, 10), event.provider, event.operation);
    group.ledgerMicroUsd += event.costMicroUsd;
    group.ledgerEventCount += 1;
  }

  for (const row of liveRows) {
    // LLM rows are compared only once the LLM mirror exists (ENG-1934).
    // Before it, including them would manufacture drift equal to the entire
    // LLM bill — that comparison is the OTHER check, below.
    if (!isVendorEntry(row)) {
      if (!llmStartDay || isUnpricedLlmRow(row)) continue;
      const group = groupFor(row.date, LLM_GROUP_PROVIDER, row.model, "llm");
      group.liveMicroUsd += row.costMicroUsd;
      group.liveCallCount += row.callCount;
      continue;
    }
    const parsed = splitVendorModel(row.model);
    // Trust the row's own provider attribute over the parsed model slot: the
    // slot is a naming convention, the attribute is the data.
    const group = groupFor(row.date, row.provider ?? parsed.provider, parsed.operation);
    group.liveMicroUsd += row.costMicroUsd;
    group.liveCallCount += row.callCount;
  }

  let ledgerMicroUsd = 0;
  let liveMicroUsd = 0;
  const driftingGroups: FidelityGroup[] = [];
  const unmirroredGroups: FidelityGroup[] = [];
  const orphanGroups: FidelityGroup[] = [];
  const preMirrorGroups: FidelityGroup[] = [];
  const partialGroups: FidelityGroup[] = [];

  for (const group of groups.values()) {
    group.driftMicroUsd = group.ledgerMicroUsd - group.liveMicroUsd;
    group.ok = Math.abs(group.driftMicroUsd) <= DRIFT_TOLERANCE_MICRO_USD;

    const startDay = group.rail === "llm" ? llmStartDay : mirrorStartDay;
    if (startDay && group.date < startDay) {
      // Entirely before the mirror existed. Not a finding.
      preMirrorGroups.push(group);
      continue;
    }
    if (startDay && group.date === startDay) {
      // The changeover day. Its live row spans both sides of the deploy and the
      // daily aggregate cannot be split, so a shortfall here is expected.
      partialGroups.push(group);
      continue;
    }

    // Totals cover ASSESSED groups only. Including history the mirror never saw
    // would print a huge drift beside `ok: true`, and a reader who trusted the
    // number over the verdict would conclude the ledger is broken when it is
    // merely young.
    ledgerMicroUsd += group.ledgerMicroUsd;
    liveMicroUsd += group.liveMicroUsd;

    if (group.ledgerEventCount === 0 && group.liveCallCount > 0) unmirroredGroups.push(group);
    else if (group.liveCallCount === 0 && group.ledgerEventCount > 0) orphanGroups.push(group);
    else if (!group.ok) driftingGroups.push(group);
  }

  return {
    // Any of the three conditions denies the clean verdict. A run with an
    // unmirrored vendor is not "within tolerance"; it is missing data.
    ok: driftingGroups.length === 0 && unmirroredGroups.length === 0 && orphanGroups.length === 0,
    ledgerMicroUsd,
    liveMicroUsd,
    driftMicroUsd: ledgerMicroUsd - liveMicroUsd,
    driftingGroups,
    unmirroredGroups,
    orphanGroups,
    preMirrorGroups,
    partialGroups,
    groupCount: groups.size,
    assessedGroupCount: groups.size - preMirrorGroups.length - partialGroups.length,
  };
}

/**
 * Which billing subjects a monthly reconciliation should actually cover.
 *
 * Vendor activity on EITHER rail makes a subject reconcilable. Deriving the set
 * from spend events alone hides the single worst case this check exists to
 * catch (CodeRabbit, PR #2805): a subject whose mirror writes ALL failed has no
 * events, so it would never be looked at, and the run would print clean
 * precisely when the mirror had failed hardest.
 *
 * Subjects with only LLM spend are returned separately rather than dropped
 * silently — they have nothing to reconcile here, but "19 subjects not listed"
 * is a materially different report from one that simply omits them.
 */
export function selectReconcilableSubjects(
  events: readonly SpendEvent[],
  liveRows: readonly UsageRecordRow[],
  /**
   * ENG-1934: once LLM events are on the ledger, LLM activity makes a subject
   * reconcilable too — otherwise a subject whose every LLM ledger write failed
   * would be filed under "LLM only, nothing to reconcile" and never examined,
   * the same blind spot the vendor rule above closes.
   */
  options: { includeLlm?: boolean } = {},
): { reconcilable: string[]; llmOnly: string[] } {
  const reconcilable = new Set<string>(
    events.filter((e) => options.includeLlm || !isLlmSpendEvent(e)).map((e) => e.billingUserId).filter(Boolean),
  );
  const llmOnly = new Set<string>();

  for (const row of liveRows) {
    if (!row.billingUserId) continue;
    if (isVendorEntry(row) || (options.includeLlm && !isUnpricedLlmRow(row))) reconcilable.add(row.billingUserId);
    else llmOnly.add(row.billingUserId);
  }
  for (const id of reconcilable) llmOnly.delete(id);

  return { reconcilable: [...reconcilable].sort(), llmOnly: [...llmOnly].sort() };
}

export interface BasisDivergenceReport {
  /** What the live gate enforces on today: token-priced LLM spend. */
  llmOnlyMicroUsd: number;
  /** What this rail would enforce on: LLM plus every metered vendor. */
  allVendorMicroUsd: number;
  vendorMicroUsd: number;
  /** How much larger the new basis is, as a percentage of the old. */
  increasePercent: number;
  /**
   * Whether the fidelity check passed AND actually assessed something.
   *
   * A divergence computed on top of a broken mirror is not a measurement. Nor
   * is one computed where no comparison happened at all — that reports `ok`
   * vacuously, which is the more dangerous of the two because it looks clean.
   */
  trustworthy: boolean;
}

/**
 * Check 2 — the number AC6 is waiting for.
 *
 * Says how much sooner an account reaches its cap if enforcement moves to this
 * rail. Carries `trustworthy` deliberately: quoting a divergence computed over
 * a mirror that is losing events would UNDERSTATE the answer, and understating
 * it argues for a cutover on false evidence.
 */
export function measureBasisDivergence(
  liveRows: readonly UsageRecordRow[],
  fidelity: FidelityReport,
): BasisDivergenceReport {
  let llmOnlyMicroUsd = 0;
  let vendorMicroUsd = 0;

  for (const row of liveRows) {
    if (isVendorEntry(row)) vendorMicroUsd += row.costMicroUsd;
    else llmOnlyMicroUsd += row.costMicroUsd;
  }

  const allVendorMicroUsd = llmOnlyMicroUsd + vendorMicroUsd;

  return {
    llmOnlyMicroUsd,
    allVendorMicroUsd,
    vendorMicroUsd,
    // An account with no LLM spend has no baseline to be a percentage of;
    // reporting Infinity or 100% would both be inventions.
    increasePercent: llmOnlyMicroUsd === 0 ? 0 : (vendorMicroUsd / llmOnlyMicroUsd) * 100,
    // `ok` alone is not enough: a run that assessed nothing reports ok
    // VACUOUSLY, and this figure would then be published as verified while
    // resting on no comparison at all. Found by running the report against
    // production, where every group was pre-mirror and the divergence printed
    // clean.
    trustworthy: fidelity.ok && fidelity.assessedGroupCount > 0,
  };
}

export interface ReconciliationReport {
  billingUserId: string;
  billingMonth: string;
  fidelity: FidelityReport;
  divergence: BasisDivergenceReport;
  /**
   * True only when the shadow is faithful AND something was actually assessed.
   *
   * A run that checked nothing reports `fidelity.ok === true` vacuously, and
   * treating that as evidence would be the worst possible failure of this
   * module: a green light produced by having no data.
   */
  readyForCutoverEvidence: boolean;
}

/**
 * Both checks for one billing subject and month.
 *
 * `readyForCutoverEvidence` states that the DATA is trustworthy and nothing
 * more. It is not a recommendation to move enforcement: §9 also requires seven
 * days of shadow running plus boundary and concurrency tests, and AC6 requires
 * Harsha's explicit approval. A green report is a precondition, not a decision.
 */
export function reconcileMonth(
  billingUserId: string,
  billingMonth: string,
  events: readonly SpendEvent[],
  liveRows: readonly UsageRecordRow[],
  options: FidelityOptions = {},
): ReconciliationReport {
  const mine = events.filter((e) => e.billingUserId === billingUserId && e.billingMonth === billingMonth);
  const myRows = liveRows.filter((r) => r.billingUserId === billingUserId && r.date.slice(0, 7) === billingMonth);

  const fidelity = reconcileVendorFidelity(mine, myRows, options);

  return {
    billingUserId,
    billingMonth,
    fidelity,
    divergence: measureBasisDivergence(myRows, fidelity),
    readyForCutoverEvidence: fidelity.ok && fidelity.assessedGroupCount > 0,
  };
}

/** How much of a billing month's LLM spend the ledger actually holds (ENG-1934). */
export interface LlmLedgerCoverage {
  /** Whether the kill switch currently lets LLM events through. */
  recording: boolean;
  startedOn: string;
  /**
   * `none`: the month ended before LLM events existed — vendor spend only.
   * `partial`: the two rails disagree by more than the §8 tolerance in either
   * direction, or that could not be measured.
   * `full`: the ledger holds the month's LLM spend, within tolerance.
   */
  month: "none" | "partial" | "full";
  ledgerLlmMicroUsd: number;
  /** null when the month predates LLM events, or the aggregate read failed. */
  aggregateLlmMicroUsd: number | null;
  /** How much LLM spend the ledger is missing; null when not measured. */
  missingLlmMicroUsd: number | null;
  /**
   * How much MORE LLM spend the ledger holds than the aggregate rail — a
   * duplicate or orphan event overstating the total. null when not measured.
   */
  excessLlmMicroUsd: number | null;
}

/**
 * Measure, rather than assume, how complete a month's LLM ledger is.
 *
 * Deriving "full" from the start date and the kill switch would call a month
 * complete after the switch was off for a week, or after an outage whose
 * writes fell back to the aggregate alone (CodeRabbit, PR #2904). Every such
 * gap has the same signature — LLM cost on the aggregate rail with no event
 * behind it — so comparing the two rails catches all of them, including the
 * portion of the start month before recording began, without persisting any
 * gap state.
 *
 * Both rails dedupe and attribute identically since ENG-1934, so a
 * difference within the §8 tolerance is rounding, and anything larger is
 * spend the allowance comparison cannot see.
 */
export function measureLlmLedgerCoverage(
  billingMonth: string,
  events: readonly SpendEvent[],
  aggregateRows: readonly UsageRecordRow[] | null,
): LlmLedgerCoverage {
  const ledgerLlmMicroUsd = events
    .filter((e) => e.billingMonth === billingMonth && e.lifecycle === "settled" && isLlmSpendEvent(e))
    .reduce((sum, e) => sum + e.costMicroUsd, 0);
  const base = { recording: isLlmDualWriteEnabled(), startedOn: LLM_SPEND_LEDGER_STARTED_ON, ledgerLlmMicroUsd };

  if (billingMonth < LLM_SPEND_LEDGER_STARTED_ON.slice(0, 7)) {
    return { ...base, month: "none", aggregateLlmMicroUsd: null, missingLlmMicroUsd: null, excessLlmMicroUsd: null };
  }
  if (!aggregateRows) {
    // Unmeasured is not complete.
    return { ...base, month: "partial", aggregateLlmMicroUsd: null, missingLlmMicroUsd: null, excessLlmMicroUsd: null };
  }

  const aggregateLlmMicroUsd = aggregateRows
    .filter((r) => r.date.slice(0, 7) === billingMonth && !isVendorEntry(r) && !isUnpricedLlmRow(r))
    .reduce((sum, r) => sum + r.costMicroUsd, 0);
  const missingLlmMicroUsd = Math.max(0, aggregateLlmMicroUsd - ledgerLlmMicroUsd);
  const excessLlmMicroUsd = Math.max(0, ledgerLlmMicroUsd - aggregateLlmMicroUsd);

  return {
    ...base,
    // Either direction: a ledger that holds MORE than the aggregate is
    // overstating spend, and that is no more "full" than a shortfall is
    // (CodeRabbit, PR #2904).
    month: Math.max(missingLlmMicroUsd, excessLlmMicroUsd) > DRIFT_TOLERANCE_MICRO_USD ? "partial" : "full",
    aggregateLlmMicroUsd,
    missingLlmMicroUsd,
    excessLlmMicroUsd,
  };
}
