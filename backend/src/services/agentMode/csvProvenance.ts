/**
 * Pure CSV provenance helpers for `perform_data_analysis` (ENG-1295, ENG-1600).
 *
 * Extracted from `agentModeService` per the repo's subtraction-biased complexity policy: these
 * six functions read no instance state, and living in the 36k-line service meant the CSV-parsing
 * correctness that ENG-1600 fixed could not be unit-tested without loading the whole thing.
 *
 * The cache read/write and response assembly deliberately stay in the service — they DO touch
 * instance state (`dataAnalysisConsistencyCache`), and moving them would have needed the state
 * to move too, which is a different change.
 */
import { parse as parseCsv } from 'csv-parse/sync';
import { createHash } from 'crypto';

/**
 * ENG-1295 provenance/consistency helper: parses a generated CSV block into its
 * header, rows, data-row count, and the distinct values of its first column —
 * the grouping-key convention this tool's prompts ask the model to use (see the
 * per-ad-group / per-user breakdown instructions in the callers of this tool).
 * Used to append a cheap-to-verify provenance stub, to diff repeat calls for
 * self-consistency, and to check the CSV's own internal id/name consistency.
 */
export function parseCsvProvenance(csvText: string): { rowsOut: number; groupingKeyValues: string[]; header: string[]; rows: string[][] } | null {
  // ENG-1600: was `line.split(',')`, which breaks on any quoted field containing a comma
  // ("Acme, Inc") and shifts every column after it left. That misalignment is not cosmetic:
  // column 0 feeds the cross-call comparison below, which HARD-REJECTS the analysis with
  // `inconsistent_result` — so a shifted row on one run and not the other refuses a correct
  // analysis. `csv-parse` is already imported here and used elsewhere in this file.
  let parsed: string[][];
  try {
    parsed = parseCsv(csvText, {
      skip_empty_lines: true,
      trim: true,
      // Generated CSVs are not guaranteed rectangular; a ragged row must not throw away the
      // whole provenance check, which is the only guard against fabricated output.
      relax_column_count: true,
      relax_quotes: true,
    }) as string[][];
  } catch (error) {
    console.warn('AgentMode: parseCsvProvenance could not parse the generated CSV:', error);
    return null;
  }
  if (parsed.length === 0) return null;
  const header = parsed[0];
  const rows = parsed.slice(1); // first line is assumed to be the header
  const groupingKeyValues: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const firstCol = row[0];
    if (firstCol && !seen.has(firstCol)) {
      seen.add(firstCol);
      groupingKeyValues.push(firstCol);
    }
  }
  return { rowsOut: rows.length, groupingKeyValues, header, rows };
}

/** ENG-1295: splits a CSV header cell into lowercase word tokens (camelCase- and separator-aware) for id/name column detection. */
export function tokenizeCsvHeaderCell(cell: string): string[] {
  return cell
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .map(t => t.toLowerCase())
    .filter(Boolean);
}

/**
 * ENG-1295 intra-response check: detects the exact failure pattern that
 * produced the prod hallucination — the SAME id mapped to more than one
 * DIFFERENT name within one generated CSV (e.g. id 199836788398 as both
 * "Product Analytics Platform" and "Game Analytics Platform"). This requires
 * no narrative parsing. Informational only, NOT a hard reject: a real entity
 * (an ad group, a CRM lead's company, etc.) can legitimately be renamed
 * within a query's date window, which would produce this exact shape from
 * genuinely correct source data — we can't tell "renamed" apart from
 * "fabricated" using the CSV alone, so this is surfaced in Provenance for the
 * caller to judge rather than blocking a possibly-correct result. Only
 * applies when the CSV actually has both an id-like and a name-like column.
 */
export function findCsvIdNameCollisions(header: string[], rows: string[][]): { id: string; names: string[] }[] {
  const idIdx = header.findIndex(h => tokenizeCsvHeaderCell(h).includes('id'));
  const nameIdx = header.findIndex(h => tokenizeCsvHeaderCell(h).includes('name'));
  if (idIdx === -1 || nameIdx === -1 || idIdx === nameIdx) return [];
  const idToNames = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = row[idIdx];
    const name = row[nameIdx];
    if (!id || !name) continue;
    if (!idToNames.has(id)) idToNames.set(id, new Set());
    idToNames.get(id)!.add(name);
  }
  const collisions: { id: string; names: string[] }[] = [];
  for (const [id, names] of idToNames) {
    if (names.size > 1) {
      collisions.push({ id, names: [...names] });
    }
  }
  return collisions;
}

/**
 * ENG-1295 grounding check: for a CSV with an id-like column, verifies each
 * distinct id actually occurs somewhere in the raw source file(s) that were
 * sent to the sandbox — the same objective technique the agent used manually
 * (search_tool_response) to catch the fabricated name in prod session
 * d789c175. Informational only (not a hard reject): a substring miss can also
 * mean the model reformatted the id, so this is surfaced as a provenance
 * caveat rather than blocking a possibly-correct result.
 */
export function checkCsvIdGrounding(header: string[], rows: string[][], fileRawContents: string[]): { checked: number; unverified: number } | null {
  const idIdx = header.findIndex(h => tokenizeCsvHeaderCell(h).includes('id'));
  if (idIdx === -1 || fileRawContents.length === 0) return null;
  const distinctIds = [...new Set(rows.map(r => r[idIdx]).filter(Boolean))];
  if (distinctIds.length === 0) return null;
  const combinedSource = fileRawContents.join('\n');
  const unverified = distinctIds.filter(id => !combinedSource.includes(id)).length;
  return { checked: distinctIds.length, unverified };
}

/**
 * ENG-1295 provenance helper: best-effort input row count for a source file, so
 * the caller can cheaply sanity-check rows_out against rows_in. Counts elements
 * of the largest JSON array found (top-level array, or the largest array
 * property for the common `{ results: [...] }` / `{ sessions: [...] }` API-
 * response shape used throughout this codebase), falling back to a non-empty
 * line count for non-JSON content. This is a heuristic, not an exact parse of
 * the analysis_instruction's semantics.
 */
export function estimateRowsIn(rawContent: string): number | null {
  const trimmed = rawContent.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') {
      let maxLen = -1;
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value) && value.length > maxLen) maxLen = value.length;
      }
      if (maxLen >= 0) return maxLen;
    }
  } catch {
    // Not JSON — fall through to a line-count approximation.
  }
  return trimmed.split('\n').filter(l => l.trim().length > 0).length;
}

/** ENG-1295: cache key for the self-consistency check — exact (userId, file_urls, analysis_instruction) match. */
export function buildDataAnalysisCacheKey(userId: string, fileUrls: string[], analysisInstruction: string): string {
  const hash = createHash('sha256').update(JSON.stringify(fileUrls) + '\u0000' + analysisInstruction).digest('hex');
  return `${userId}:${hash}`;
}

