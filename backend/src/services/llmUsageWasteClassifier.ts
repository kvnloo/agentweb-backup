/**
 * ENG-2952 (ENG-1659 item 1) — system-waste classifier over the usage ledger.
 *
 * Pure and read-only: takes rows already read by `llmUsageLedgerReader` and
 * splits each account's spend into `userWork`, `systemWaste` and `unknown`.
 * It writes nothing, switches nothing, stops nothing.
 *
 * ## What today's ledger can prove
 *
 * `AW-UsageRecords` rows are DAILY AGGREGATES keyed `userId` /
 * `date#model#feature`. Per-call identity is summed away at write time, so:
 *
 *  - retries after failure: no call id, attempt number or error status on the
 *    row — undetectable.
 *  - duplicate identical tool calls within one run: no run id and no
 *    tool-call arguments hash — undetectable.
 *  - scheduled runs with no user-visible output: the `:scheduled` provenance tag
 *    exists (ENG-1213), but nothing records whether the run produced output, so
 *    a scheduled row cannot be called waste.
 *
 * Each class is therefore reported with `detectable: false` and the missing
 * field(s) named. Adding those fields is data-plane work (Requires: Me) and is
 * deliberately not done here. Until then, spend is never guessed into a side:
 * only rows tagged `:interactive` count as user work; scheduled and untagged
 * spend goes to `unknown`. Totals are integer micro-USD sums, the same unit
 * and rule as `llmUsageAttributionService`, so they reconcile exactly.
 */

import { normaliseFeature } from "./llmUsageAttributionService";

export interface WasteLedgerRow {
  userId: string;
  date: string;
  model: string;
  feature: string;
  costMicroUsd: number;
  callCount?: number;
}

export type WasteClass = "retry_after_failure" | "duplicate_tool_call" | "scheduled_no_output";

export interface WasteClassResult {
  costMicroUsd: number;
  /** Ledger row ids (`userId|date#model#feature`) that produced this class. */
  evidenceRowIds: string[];
  detectable: boolean;
  /** Fields the ledger would need for this class to be measurable. */
  missingFields: string[];
}

export interface UnknownBreakdown {
  scheduledMicroUsd: number;
  untaggedMicroUsd: number;
  evidenceRowIds: string[];
}

export interface AccountWasteSummary {
  userId: string;
  totalCostMicroUsd: number;
  userWorkMicroUsd: number;
  systemWasteMicroUsd: number;
  unknownMicroUsd: number;
  systemWaste: Record<WasteClass, WasteClassResult>;
  unknown: UnknownBreakdown;
  /** ENG-1532 precedent: no savings figure here implies no task-success regression. */
  qualityImpact: "quality impact unknown";
  reconciles: boolean;
}

export const WASTE_CLASS_MISSING_FIELDS: Readonly<Record<WasteClass, readonly string[]>> = {
  retry_after_failure: ["per-call id", "attempt number", "call outcome/error status"],
  duplicate_tool_call: ["run/session id", "tool name", "tool-call arguments hash"],
  scheduled_no_output: ["run id", "user-visible output produced flag"],
};

export function wasteRowId(row: WasteLedgerRow): string {
  return `${row.userId}|${row.date}#${row.model}#${row.feature}`;
}

function provenanceOf(feature: string): "scheduled" | "interactive" | null {
  const tag = feature.slice(normaliseFeature(feature).length + 1).split(":")[0];
  return tag === "scheduled" || tag === "interactive" ? tag : null;
}

function emptyClasses(): Record<WasteClass, WasteClassResult> {
  const out = {} as Record<WasteClass, WasteClassResult>;
  for (const k of Object.keys(WASTE_CLASS_MISSING_FIELDS) as WasteClass[]) {
    out[k] = {
      costMicroUsd: 0,
      evidenceRowIds: [],
      detectable: false,
      missingFields: [...WASTE_CLASS_MISSING_FIELDS[k]],
    };
  }
  return out;
}

function toMicro(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Classify already-read ledger rows into per-account user work / system waste / unknown. */
export function classifyUsageWaste(rows: readonly WasteLedgerRow[]): AccountWasteSummary[] {
  const byAccount = new Map<string, AccountWasteSummary>();
  for (const row of rows) {
    let acc = byAccount.get(row.userId);
    if (!acc) {
      acc = {
        userId: row.userId,
        totalCostMicroUsd: 0,
        userWorkMicroUsd: 0,
        systemWasteMicroUsd: 0,
        unknownMicroUsd: 0,
        systemWaste: emptyClasses(),
        unknown: { scheduledMicroUsd: 0, untaggedMicroUsd: 0, evidenceRowIds: [] },
        qualityImpact: "quality impact unknown",
        reconciles: true,
      };
      byAccount.set(row.userId, acc);
    }
    const cost = toMicro(row.costMicroUsd);
    acc.totalCostMicroUsd += cost;
    const source = provenanceOf(row.feature ?? "");
    if (source === "interactive") {
      acc.userWorkMicroUsd += cost;
      continue;
    }
    acc.unknownMicroUsd += cost;
    acc.unknown.evidenceRowIds.push(wasteRowId(row));
    if (source === "scheduled") acc.unknown.scheduledMicroUsd += cost;
    else acc.unknown.untaggedMicroUsd += cost;
  }
  for (const acc of byAccount.values()) {
    acc.systemWasteMicroUsd = Object.values(acc.systemWaste).reduce((s, c) => s + c.costMicroUsd, 0);
    acc.reconciles =
      acc.userWorkMicroUsd + acc.systemWasteMicroUsd + acc.unknownMicroUsd === acc.totalCostMicroUsd;
  }
  return [...byAccount.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}
