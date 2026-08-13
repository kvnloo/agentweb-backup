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

/** Head-room left inside the run's budget for building and returning the
 *  ledger once the import stops writing. */
export const LEAD_IMPORT_LEDGER_RESERVE_MS = 5_000;

/**
 * The write budget for THIS call, clamped to what the run has left.
 *
 * The flat budget above is only safe when the turn itself has that long to
 * give. A call that starts with 30s of run budget remaining and then takes the
 * full 120s is guillotined by the generation timeout mid-write, and the ledger
 * never comes back — the exact failure the budget exists to prevent. So bound
 * it by the run's remaining wall-clock, less enough to hand the ledger back.
 *
 * Never returns 0: the DB layer reads a non-positive budget as "unbounded",
 * and a positive floor still lets the first unit of work through (its first
 * unit is unconditional), so a resume always makes some progress.
 *
 * `turnDeadlineMs` must be the turn's real wall-clock cap and nothing else. The
 * media-generation soft deadline is NOT a bound on the turn: it sits 3 minutes
 * inside the cap, so clamping to it under-budgets the import, and once it has
 * passed the run still has minutes left while this would floor to 1ms and
 * starve every write. Absent a real cap (scheduled/Slack/email runs impose
 * none) the flat budget stands — there is no turn for the import to outlive.
 */
export function leadImportWriteBudgetMs(now: number, turnDeadlineMs?: number): number {
  if (!Number.isFinite(turnDeadlineMs as number)) return LEAD_IMPORT_WRITE_BUDGET_MS;
  const remaining = (turnDeadlineMs as number) - now - LEAD_IMPORT_LEDGER_RESERVE_MS;
  return Math.max(1, Math.min(LEAD_IMPORT_WRITE_BUDGET_MS, remaining));
}

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

/**
 * ENG-1174: the row totals an import actually achieved this turn, read back off the
 * persisted transcript.
 *
 * When a turn THROWS, the diagnosis agent in agentModeController's catch is handed
 * only `calledFunctions` — a histogram of how many times each tool was CALLED. That is
 * why ENG-1173 has to strip every quantity from its prose: reading `add_leads_to_list: 3`
 * as "3 leads" is exactly the production defect (session 39eb5663 wrote 75 rows across
 * three calls and told the user "the 3 leads").
 *
 * The real numbers do survive, though. The minimal stored result deliberately keeps
 * `attempted` / `reconciliation` on the tool message so the NEXT turn can resume, so a
 * thrown turn's diagnosis can read them from the same place. No new persisted state is
 * needed — this is a read.
 */
export interface LeadImportTotals {
  /** Rows confirmed to be in the list: created + merged + alreadyPresent. */
  landed: number;
  /** Rows this turn tried to write. */
  attempted: number;
  /**
   * False when no import result this turn could be read as an ENG-1133 result —
   * absent, unparseable, error-enveloped, or predating the contract.
   *
   * UNKNOWN is NOT zero, and collapsing the two would recreate the very bug this
   * fixes with a different wrong number: telling a user that nothing was written
   * when 75 rows are sitting in their CRM is worse than telling them nothing.
   */
  known: boolean;
}

/** Timestamped transcript message, as the persisted session stores it. */
interface TranscriptMessageLike {
  role?: string;
  name?: string;
  content?: unknown;
  timestamp?: string;
  metadata?: { timestamp?: string; [k: string]: unknown };
}

const UNKNOWN_TOTALS: LeadImportTotals = { landed: 0, attempted: 0, known: false };

export function collectLeadImportTotals(
  messages: TranscriptMessageLike[] | null | undefined,
  sinceMs: number,
): LeadImportTotals {
  if (!Array.isArray(messages)) return UNKNOWN_TOTALS;

  let landed = 0;
  let attempted = 0;
  let known = false;

  for (const message of messages) {
    if (!message || message.role !== 'tool' || message.name !== 'add_leads_to_list') continue;

    const rawTs = message.timestamp || message.metadata?.timestamp;
    const ts = rawTs ? Date.parse(rawTs) : NaN;
    // No usable timestamp: this batch can be neither included nor excluded with
    // confidence. SKIPPING it is the dangerous choice — the surviving batches still
    // report `known: true`, so a 75-row import silently becomes an authoritative
    // "50". An unattributable batch therefore poisons the whole sum.
    if (!Number.isFinite(ts)) return UNKNOWN_TOTALS;
    // A batch that provably predates this turn is a different matter: it is excluded
    // on evidence, not on ignorance, so the remaining sum stays trustworthy.
    if (ts < sinceMs) continue;

    const text = typeof message.content === 'string' ? message.content : '';
    // A tool result wearing the error envelope is a FAILED call, never a total.
    if (!text || text.includes('⚠️ Tool Error')) return UNKNOWN_TOTALS;

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      // One unreadable batch makes the SUM unreliable, not just that batch — so the
      // whole answer degrades to UNKNOWN rather than silently under-reporting.
      return UNKNOWN_TOTALS;
    }

    const rec = parsed?.reconciliation;
    if (!rec || typeof rec !== 'object' || typeof parsed?.attempted !== 'number') {
      // Pre-ENG-1133 shape (successCount/newCount) or something else entirely.
      return UNKNOWN_TOTALS;
    }

    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    // ENG-1133's own definition, reused rather than reinvented: a merged or
    // already-present row IS in the list, so it counts as landed.
    landed += num(rec.created) + num(rec.merged) + num(rec.alreadyPresent);
    attempted += parsed.attempted;
    known = true;
  }

  return known ? { landed, attempted, known: true } : UNKNOWN_TOTALS;
}

/**
 * ENG-1174: one factual line for the diagnosis prompt, or null when there is nothing
 * trustworthy to say. Phrased in ROWS so it cannot be mistaken for the run-count
 * ledger that sits beside it in the same prompt.
 */
export function describeLeadImportTotals(totals: LeadImportTotals | null | undefined): string | null {
  if (!totals || !totals.known || totals.attempted <= 0) return null;

  return totals.landed >= totals.attempted
    ? `Lead import rows written this run: ${totals.landed} row(s), all of the ${totals.attempted} attempted.`
    : `Lead import rows written this run: ${totals.landed} of ${totals.attempted} row(s) attempted — `
      + `${totals.attempted - totals.landed} row(s) did not land. These are ROW counts, not run counts.`;
}
