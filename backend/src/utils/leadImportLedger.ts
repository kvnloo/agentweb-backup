/**
 * Helpers for reporting a bulk lead import row by row (ENG-1133).
 *
 * A large import can stop part-way — the agent-mode whole-turn cap fires
 * between two `add_leads_to_list` calls, and the run ends with some rows
 * written and some not. Aggregate counts ("25 new lead(s) created") do not say
 * WHICH rows those were, so the only continuation on offer was to replay the
 * whole file. These helpers turn the DB layer's per-row outcome ledger into
 * something a caller can resume from.
 */

import { LeadImportRowOutcome } from './leadSchema';

/** Longest row list echoed back in a tool result before it is truncated.
 *  Keeps a large import's result well clear of the size at which the agent
 *  layer replaces a tool response with a preview. Applies to the INFORMATIONAL
 *  lists only — see `capLeadResumeRows` for why the resume list is budgeted by
 *  size instead. */
export const LEAD_IMPORT_ROW_LIST_CAP = 100;

/**
 * Size budget for the resume list, in bytes of serialized JSON.
 *
 * Counting rows was the wrong unit here. A resume list is bounded by the
 * request that produced it — one ~70-byte ledger entry per row the caller just
 * sent as a ~200-byte object — so echoing ALL of it back costs a fraction of
 * the arguments the model already emitted, and a flat 100-row cap truncated
 * lists that were never a size problem (a 200-row shortfall is ~14KB). What the
 * cap protects against is only the pathological tail, so budget it in the unit
 * that actually matters and let every realistic partial through whole.
 */
export const LEAD_IMPORT_RESUME_BYTE_BUDGET = 32_768;

/**
 * Wall-clock budget for the writes behind one `add_leads_to_list` call.
 *
 * Sized well inside the agent-mode whole-turn cap (600s, see
 * AGENT_MODE_GENERATION_TIMEOUT_MS) so that when an import cannot finish — a
 * throttled table, or a re-sent file whose every row needs its own sequential
 * merge round-trip — the tool RETURNS a partial naming the rows it still owes,
 * and the agent resumes them. Running to the turn cap instead kills the turn
 * with no tool result at all, which is the failure this ticket was filed for.
 */
export const LEAD_IMPORT_WRITE_BUDGET_MS = 120_000;

/**
 * Normalize the per-row ledger from a `crmDb.batchCreateLeads` result.
 *
 * `rowAligned` is false when the result carries no usable ledger (a legacy or
 * stubbed caller). Outcomes are still derived from the aggregate counts so the
 * totals reconcile, but they are NOT in input order — callers must not name
 * individual rows from them.
 */
export function buildLeadImportRowOutcomes(
  result: { rowOutcomes?: unknown; newCount?: number; mergedCount?: number; alreadyPresentCount?: number; anonymizedSkipped?: number; errorCount?: number },
  attempted: number,
): { outcomes: LeadImportRowOutcome[]; rowAligned: boolean } {
  const ledger = result.rowOutcomes;
  if (Array.isArray(ledger) && ledger.length === attempted) {
    return { outcomes: ledger as LeadImportRowOutcome[], rowAligned: true };
  }

  const outcomes: LeadImportRowOutcome[] = [];
  const repeat = (outcome: LeadImportRowOutcome, count: number | undefined) => {
    for (let i = 0; i < (count || 0); i++) outcomes.push(outcome);
  };
  repeat('created', result.newCount);
  repeat('merged', result.mergedCount);
  repeat('already_present', result.alreadyPresentCount);
  repeat('anonymized_skipped', result.anonymizedSkipped);
  repeat('failed', result.errorCount);
  while (outcomes.length < attempted) outcomes.push('unprocessed');
  return { outcomes: outcomes.slice(0, attempted), rowAligned: false };
}

/**
 * Stable human/agent-readable identity for one input row: whatever the row
 * actually carries, in the same precedence the importer dedupes on. Falls back
 * to the row's position so a row is never unnameable.
 */
export function describeLeadRow(lead: any, index: number): string {
  const text = (value: any): string => (typeof value === 'string' ? value.trim() : '');
  const email = text(lead?.email);
  if (email) return email;
  const linkedin = text(lead?.linkedin);
  if (linkedin) return linkedin;
  const name = [text(lead?.firstName), text(lead?.lastName)].filter(Boolean).join(' ');
  const company = text(lead?.company);
  if (name && company) return `${name} @ ${company}`;
  if (name) return name;
  if (company) return company;
  return `row ${index + 1}`;
}

/**
 * Compact, COMPLETE description of which input positions did not land, as a
 * run-length encoded range string ("7,19,101-220").
 *
 * `capLeadResumeRows` lets every realistic partial through whole, but a
 * pathological one can still be trimmed, and a trimmed resume list left to
 * speak for itself is silent data loss: the agent imports the slice it was
 * shown, gets a clean `complete: true` for it, and reports the import finished
 * while the rest are still missing. This summary is the backstop that cannot be
 * trimmed — row positions are the resume key (the caller still holds the rows
 * it just sent), and encoding them by run costs space per RUN rather than per
 * row, so the dominant partial — a write budget or turn cap cutting the file at
 * some position — is a single range however many rows it covers.
 */
export function summarizeLeadRowNumbers(rowNumbers: number[]): string {
  const sorted = [...rowNumbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  const flush = () => {
    if (start === null || previous === null) return;
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  };
  for (const rowNumber of sorted) {
    if (previous !== null && rowNumber === previous) continue;
    if (previous !== null && rowNumber === previous + 1) {
      previous = rowNumber;
      continue;
    }
    flush();
    start = rowNumber;
    previous = rowNumber;
  }
  flush();
  return parts.join(',');
}

/**
 * Echo the resume list back under `key`, keeping every row that fits inside
 * `LEAD_IMPORT_RESUME_BYTE_BUDGET`. A trimmed list always says so, and at least
 * one row is always named so a resume is never left with nothing to act on.
 */
export function capLeadResumeRows<T>(key: string, rows: T[]): Record<string, any> {
  let budget = LEAD_IMPORT_RESUME_BYTE_BUDGET;
  let kept = 0;
  for (const row of rows) {
    budget -= JSON.stringify(row).length + 1;
    if (budget < 0 && kept > 0) break;
    kept++;
  }
  if (kept >= rows.length) {
    return { [key]: rows };
  }
  return {
    [key]: rows.slice(0, kept),
    [`${key}Truncated`]: { shown: kept, total: rows.length },
  };
}

/**
 * Echo an informational row list back under `key`, truncated at the cap. A
 * truncated list always says so — a silently shortened list reads as "that is
 * all of them".
 */
export function capLeadRowList<T>(key: string, rows: T[]): Record<string, any> {
  if (rows.length <= LEAD_IMPORT_ROW_LIST_CAP) {
    return { [key]: rows };
  }
  return {
    [key]: rows.slice(0, LEAD_IMPORT_ROW_LIST_CAP),
    [`${key}Truncated`]: { shown: LEAD_IMPORT_ROW_LIST_CAP, total: rows.length },
  };
}
