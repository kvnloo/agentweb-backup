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
 *  layer replaces a tool response with a preview. */
export const LEAD_IMPORT_ROW_LIST_CAP = 100;

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
 * Echo a row list back under `key`, truncated at the cap. A truncated list
 * always says so — a silently shortened resume list reads as "that is all of
 * them" and would strand the rest.
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
