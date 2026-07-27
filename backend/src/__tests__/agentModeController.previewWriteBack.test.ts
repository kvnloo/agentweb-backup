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
 * This adds a deterministic, tool-call-based backstop: if a scheduled run reached
 * a PREVIEW/dry-run tool but never its EXECUTE write-back counterpart, the gate
 * must fire one more continuation so the write-back actually runs — mirroring the
 * budget/confirmation/unfinished continuations.
 */

import {
  scheduledRunPreviewedWithoutExecute,
  classifyScheduledContinuation,
  scheduledRunSignalsIncompleteResponse,
} from '../controllers/agentModeController';

describe('scheduledRunPreviewedWithoutExecute — preview→execute completion detector', () => {
  // ── FAIL cases: previewed but never committed the write-back ────────────────
  it('fires when enrich_leads_preview was called but enrich_leads_execute was not', () => {
    const toolCalls = [
      'get_lead_lists',
      'get_leads',
      'enrich_leads_preview',
      'enrich_leads_preview',
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(true);
  });

  it('fires when multiple previews ran but zero executes (the ENG-518 shape)', () => {
    const toolCalls = [
      'install_skills',
      'get_lead_lists',
      'get_leads', 'get_leads', 'get_leads', 'get_leads', 'get_leads', 'get_leads',
      'enrich_leads_preview', 'enrich_leads_preview', 'enrich_leads_preview',
      'enrich_leads_preview', 'enrich_leads_preview', 'enrich_leads_preview',
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(true);
  });

  // ── PASS cases: write-back happened, or preview never ran ───────────────────
  it('does NOT fire when the execute write-back also ran', () => {
    const toolCalls = [
      'get_leads',
      'enrich_leads_preview',
      'enrich_leads_execute',
    ];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });

  it('does NOT fire when no preview tool was called', () => {
    const toolCalls = ['get_lead_lists', 'get_leads', 'you_search_web'];
    expect(scheduledRunPreviewedWithoutExecute(toolCalls)).toBe(false);
  });

  // ── Robustness ──────────────────────────────────────────────────────────────
  it('handles empty / non-array inputs without throwing', () => {
    expect(scheduledRunPreviewedWithoutExecute([])).toBe(false);
    expect(scheduledRunPreviewedWithoutExecute(undefined as any)).toBe(false);
    expect(scheduledRunPreviewedWithoutExecute(null as any)).toBe(false);
  });
});

describe('classifyScheduledContinuation — preview-only reason', () => {
  it("classifies a preview-only run as 'preview-only'", () => {
    expect(
      classifyScheduledContinuation({
        content: 'Here are the enriched samples for all six lists.',
        toolCallNames: ['enrich_leads_preview', 'enrich_leads_preview'],
      })
    ).toBe('preview-only');
  });

  it("returns null once the write-back has run, even with a clean report", () => {
    expect(
      classifyScheduledContinuation({
        content: 'Enrichment committed for all six lists. Recommended 10 leads below.',
        toolCallNames: ['enrich_leads_preview', 'enrich_leads_execute'],
      })
    ).toBeNull();
  });

  it('preview-only takes precedence over a plain unfinished-work admission', () => {
    expect(
      classifyScheduledContinuation({
        content: 'I did not finish the remaining lists.',
        toolCallNames: ['enrich_leads_preview'],
      })
    ).toBe('preview-only');
  });

  it('scheduledRunSignalsIncompleteResponse fires on a preview-only run', () => {
    expect(
      scheduledRunSignalsIncompleteResponse({
        content: 'Preview samples shown above.',
        toolCallNames: ['enrich_leads_preview'],
      })
    ).toBe(true);
  });

  it('does not fire on preview-only detection when toolCallNames is omitted', () => {
    // Back-compat: callers that do not pass tool names get the pre-ENG-518 behavior.
    expect(
      classifyScheduledContinuation({ content: 'Preview samples shown above.' })
    ).toBeNull();
  });
});
