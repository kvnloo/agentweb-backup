/**
 * ENG-1054: the executed-action ledger is the last thing the user sees when the
 * model cannot write a synthesis, so it must never describe an action that did not
 * actually run. Two ledger entries carry no `error` yet were never executed —
 * budget-deferred media calls (`result.deferred`) and duplicate-suppressed calls
 * (`duplicateOf`) — and bucketing purely on `'error' in call` shipped both under
 * "already applied".
 */

import { buildExecutedActionsFallback, buildExecutedActionsFooter } from '../../services/agentMode/core/synthesisResidue';

describe('buildExecutedActionsFallback — outcome bucketing (ENG-1054)', () => {
  it('reports succeeded and failed calls separately', () => {
    const text = buildExecutedActionsFallback([
      { name: 'meta_ads_manage', result: { ok: true } },
      { name: 'meta_ads_manage', result: { ok: true } },
      { name: 'read_brand_guidelines', error: new Error('boom') },
    ]);

    expect(text).toContain('- meta_ads_manage — 2 succeeded');
    expect(text).toContain('- read_brand_guidelines — 1 failed');
    expect(text).toContain('already been applied');
  });

  it('never claims a budget-deferred call was applied', () => {
    const text = buildExecutedActionsFallback([
      { name: 'generate_image', result: { deferred: true, reason: 'media_generation_time_budget' } },
    ]);

    expect(text).toContain('- generate_image — 1 not run (paused for budget)');
    expect(text).not.toContain('succeeded');
    expect(text).not.toContain('already been applied');
    expect(text).toContain('were never executed');
  });

  it('keeps deferred calls out of the succeeded count when both are present', () => {
    const text = buildExecutedActionsFallback([
      { name: 'generate_image', result: { url: 'https://example.com/a.png' } },
      { name: 'generate_image', result: { deferred: true } },
    ]);

    expect(text).toContain('- generate_image — 1 succeeded, 1 not run (paused for budget)');
    expect(text).toContain('already been applied');
    expect(text).toContain('were never executed');
  });

  // Only a THROWN failure reaches the dispatcher's error path (toolDispatch.ts:440).
  // A handler that REPORTS failure by returning `{success:false}` is pushed through
  // the success path (toolDispatch.ts:849) with no `error` key — so without this it
  // would be recapped as applied, on the one message the user has left to trust.
  it('never claims a returned {success:false} call was applied', () => {
    const text = buildExecutedActionsFallback([
      { name: 'call_meta_marketing_api', result: { success: false, error: 'User request limit reached' } },
    ]);

    expect(text).toContain('- call_meta_marketing_api — 1 failed');
    expect(text).not.toContain('succeeded');
    expect(text).not.toContain('already been applied');
  });

  it('splits succeeded from returned-failure calls of the same tool', () => {
    const text = buildExecutedActionsFallback([
      { name: 'call_meta_marketing_api', result: { success: true } },
      { name: 'call_meta_marketing_api', result: { success: false } },
    ]);

    expect(text).toContain('- call_meta_marketing_api — 1 succeeded, 1 failed');
  });

  // The mirror-image error: most results carry no `success` key at all, and
  // treating a missing flag as failure would under-report actions that really ran.
  it('still counts a result with no success flag as succeeded', () => {
    const text = buildExecutedActionsFallback([
      { name: 'call_meta_marketing_api', result: {} },
      { name: 'list_knowledge_base_files', result: { knowledge_bases: [] } },
    ]);

    expect(text).toContain('- call_meta_marketing_api — 1 succeeded');
    expect(text).toContain('- list_knowledge_base_files — 1 succeeded');
    expect(text).not.toContain('failed');
  });

  it('does not double-count a duplicate-suppressed call', () => {
    const text = buildExecutedActionsFallback([
      { name: 'meta_ads_manage', result: { ok: true } },
      { name: 'meta_ads_manage', duplicateOf: 'call-1' },
    ]);

    expect(text).toContain('- meta_ads_manage — 1 succeeded');
    expect(text).not.toContain('2 succeeded');
  });

  it('says nothing changed when the ledger is empty', () => {
    expect(buildExecutedActionsFallback([])).toContain('No actions were taken');
  });
});

/**
 * ENG-1054: "the model emitted characters" is not "the model answered". When a
 * turn's synthesis broke once and the retry then produced text, the record of what
 * executed must survive alongside that text — not be suppressed by it.
 */
describe('buildExecutedActionsFooter — recovered-turn recap (ENG-1054)', () => {
  it('reports what ran so a drifting retry cannot erase the record', () => {
    const footer = buildExecutedActionsFooter([
      { name: 'call_meta_marketing_api', result: {} },
      { name: 'call_meta_marketing_api', result: {} },
      { name: 'list_knowledge_base_files', result: {} },
    ]) as string;

    expect(footer).toContain("didn't come through correctly");
    expect(footer).toContain('- call_meta_marketing_api — 2 succeeded');
    expect(footer).toContain('- list_knowledge_base_files — 1 succeeded');
    expect(footer).toContain('already been applied');
  });

  it('never claims a failed-only run was applied', () => {
    const footer = buildExecutedActionsFooter([
      { name: 'call_meta_marketing_api', error: new Error('rate limited') },
    ]) as string;

    expect(footer).toContain('- call_meta_marketing_api — 1 failed');
    expect(footer).not.toContain('already been applied');
  });

  it('honours the same deferred/duplicate rules as the full fallback', () => {
    const footer = buildExecutedActionsFooter([
      { name: 'generate_image', result: { deferred: true } },
      { name: 'meta', result: { ok: true } },
      { name: 'meta', duplicateOf: 'call-1' },
    ]) as string;

    expect(footer).toContain('- generate_image — 1 not run (paused for budget)');
    expect(footer).toContain('- meta — 1 succeeded');
    expect(footer).not.toContain('2 succeeded');
  });

  it('returns null when there is nothing to report, so nothing is appended', () => {
    expect(buildExecutedActionsFooter([])).toBeNull();
  });
});
