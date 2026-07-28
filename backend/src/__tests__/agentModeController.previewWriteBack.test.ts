/**
 * Unit tests for scheduledRunPreviewedWithoutExecute() and its integration into
 * the scheduled-run completion-gate classifier (ENG-518).
 *
 * Background: A scheduled "Lead Auto-Enrichment" run called enrich_leads_preview
 * (a dry-run sample) six times but NEVER called the enrich_leads_execute
 * write-back, then ended — the enrichment was previewed but never committed. The
 * existing completion gate only detects budget truncation and text-based
 * confirmation/unfinished admissions, so a turn that presents the preview samples
 * as if they were the deliverable slips through as "complete".
 *
 * This adds a deterministic, PER-LIST, RESULT-AWARE backstop: it fires only for a
 * list that was previewed AND came back enrichable (processedCount > 0) AND was
 * never committed by an enrich_leads_execute for that same list_id. That both
 * (a) still fires on a partial multi-list run (some lists executed, others not),
 * and (b) does NOT force a write for an unenrichable preview (processedCount 0) —
 * so the gate never commands CRM writes a preview never warranted.
 */

import {
  scheduledRunPreviewedWithoutExecute,
  classifyScheduledContinuation,
  scheduledRunSignalsIncompleteResponse,
} from '../controllers/agentModeController';

// Tool-call object as the run accumulates it: { name, arguments, result }. The
// list a call targeted lives in arguments.list_id; a preview's enrichability in
// result.processedCount.
const preview = (listId: string, processedCount: number) => ({
  name: 'enrich_leads_preview',
  arguments: { list_id: listId },
  result: { processedCount },
});
const execute = (listId: string) => ({
  name: 'enrich_leads_execute',
  arguments: { list_id: listId },
  result: { processedCount: 5 },
});
const other = (name: string) => ({ name, arguments: {}, result: {} });

describe('scheduledRunPreviewedWithoutExecute — per-list preview→execute detector', () => {
  // ── FAIL cases: an enrichable list was previewed but never committed ──────────
  it('fires when a list was previewed (enrichable) but enrich_leads_execute never ran', () => {
    const toolCalls = [other('get_lead_lists'), other('get_leads'), preview('list-1', 2)];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(true);
  });

  it('fires when multiple enrichable lists were previewed but zero executes (the ENG-518 shape)', () => {
    const toolCalls = [
      other('install_skills'),
      other('get_lead_lists'),
      preview('list-1', 2), preview('list-2', 2), preview('list-3', 2),
      preview('list-4', 2), preview('list-5', 2), preview('list-6', 2),
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(true);
  });

  it('fires on a PARTIAL multi-list run — some lists executed, an enrichable one not (Greptile P1)', () => {
    // Previewed 3 enrichable lists, executed only 2 → list-3 is still uncommitted.
    const toolCalls = [
      preview('list-1', 2), preview('list-2', 2), preview('list-3', 2),
      execute('list-1'), execute('list-2'),
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(true);
  });

  // ── PASS cases: every enrichable list committed, or nothing to commit ─────────
  it('does NOT fire when every previewed enrichable list was executed', () => {
    const toolCalls = [
      preview('list-1', 2), preview('list-2', 2),
      execute('list-1'), execute('list-2'),
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });

  it('does NOT fire for an UNENRICHABLE preview (processedCount 0) that was correctly skipped (Greptile P1)', () => {
    // list-2 resolved nobody → the model correctly did not execute it. The gate must
    // not chase it (no unauthorized write, no loop on an unenrichable list).
    const toolCalls = [
      preview('list-1', 2), preview('list-2', 0),
      execute('list-1'),
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });

  it('does NOT fire when the preview and execute are for the same single list', () => {
    const toolCalls = [other('get_leads'), preview('list-1', 2), execute('list-1')];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });

  it('does NOT fire when no preview tool was called', () => {
    const toolCalls = [other('get_lead_lists'), other('get_leads'), other('you_search_web')];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });

  // ── Robustness ──────────────────────────────────────────────────────────────
  it('handles empty / non-array inputs without throwing', () => {
    expect(scheduledRunPreviewedWithoutExecute([])).toBe(false);
    expect(scheduledRunPreviewedWithoutExecute(undefined as any)).toBe(false);
    expect(scheduledRunPreviewedWithoutExecute(null as any)).toBe(false);
  });

  it('tolerates arguments carried as a raw JSON string (preflight-failure shape)', () => {
    const toolCalls = [
      { name: 'enrich_leads_preview', arguments: JSON.stringify({ list_id: 'list-1' }), result: { processedCount: 2 } },
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(true);
  });

  it('does NOT fire (fails safe) when a preview lacks a usable list_id', () => {
    // Cannot pair without a list id → conservative: do not force a write.
    const toolCalls = [{ name: 'enrich_leads_preview', arguments: {}, result: { processedCount: 2 } }];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });
});

describe('classifyScheduledContinuation — preview-only reason', () => {
  it("classifies an enrichable-but-uncommitted preview run as 'preview-only'", () => {
    expect(
      classifyScheduledContinuation({
        content: 'Here are the enriched samples for all six lists.',
        toolCalls: [preview('list-1', 2), preview('list-2', 2)],
      })
    ).toBe('preview-only');
  });

  it('returns null once the write-back has run, even with a clean report', () => {
    expect(
      classifyScheduledContinuation({
        content: 'Enrichment committed for all six lists. Recommended 10 leads below.',
        toolCalls: [preview('list-1', 2), execute('list-1')],
      })
    ).toBeNull();
  });

  it('preview-only takes precedence over a plain unfinished-work admission', () => {
    expect(
      classifyScheduledContinuation({
        content: 'I did not finish the remaining lists.',
        toolCalls: [preview('list-1', 2)],
      })
    ).toBe('preview-only');
  });

  it('scheduledRunSignalsIncompleteResponse fires on a preview-only run', () => {
    expect(
      scheduledRunSignalsIncompleteResponse({
        content: 'Preview samples shown above.',
        toolCalls: [preview('list-1', 2)],
      })
    ).toBe(true);
  });

  it('does not fire on preview-only detection when toolCalls is omitted', () => {
    // Back-compat: callers that do not pass tool calls get the pre-ENG-518 behavior.
    expect(
      classifyScheduledContinuation({ content: 'Preview samples shown above.' })
    ).toBeNull();
  });
});
