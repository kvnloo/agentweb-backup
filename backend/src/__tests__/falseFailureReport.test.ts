// ENG-971: the INVERSION of the usual truthful-reporting failure. The work
// genuinely succeeded (landing-page changes published to production, verified by
// live smoke tests) but a trailing validation error on a NON-CRITICAL bookkeeping
// call (save_memory) was generalized by the model into "the system timed out and
// your changes were not saved — please try again". Worst case the user re-runs a
// production deploy that already landed.
//
// These tests pin the deterministic guard: when the final message asserts BOTH an
// interruption AND that the work was not saved, while the run ledger holds a
// CONFIRMED successful publish/deploy, append a visible correction naming what
// actually landed. The guard only ever ADDS text, so it can never fabricate a
// success that the ledger does not show.

import {
  reconcileFalseFailureReport,
  collectConfirmedPublishActions,
  assertsUnsavedInterruption,
  isBookkeepingTool,
  BOOKKEEPING_TOOLS,
} from '../utils/falseFailureReport';

const FALSE_FAILURE_TEXT =
  'It looks like the system timed out and your changes were not saved. Please try again.';

describe('falseFailureReport', () => {
  describe('isBookkeepingTool', () => {
    it('treats the cross-session memory tools as bookkeeping', () => {
      expect(isBookkeepingTool('save_memory')).toBe(true);
      expect(isBookkeepingTool('save_org_memory')).toBe(true);
      expect(isBookkeepingTool('delete_memory')).toBe(true);
      expect(isBookkeepingTool('delete_org_memory')).toBe(true);
      expect(BOOKKEEPING_TOOLS.has('save_memory')).toBe(true);
    });

    // FAIL cases: primary, user-visible work is never bookkeeping.
    it('does not treat publish/deploy or content tools as bookkeeping', () => {
      expect(isBookkeepingTool('publish_landing_page_changes')).toBe(false);
      expect(isBookkeepingTool('deploy_landing_page')).toBe(false);
      expect(isBookkeepingTool('update_knowledge_base_file')).toBe(false);
      expect(isBookkeepingTool('')).toBe(false);
    });
  });

  describe('assertsUnsavedInterruption', () => {
    it('detects the ENG-971 phrase pattern', () => {
      expect(assertsUnsavedInterruption(FALSE_FAILURE_TEXT)).toBe(true);
      expect(
        assertsUnsavedInterruption('The session timed out, so nothing was saved.'),
      ).toBe(true);
      expect(
        assertsUnsavedInterruption('Request timeout — your edits were lost. Try again.'),
      ).toBe(true);
    });

    // FAIL cases: one half of the pattern alone must never fire the guard.
    it('does not fire on an interruption claim alone', () => {
      expect(
        assertsUnsavedInterruption('The web search timed out, but everything else is done and saved.'),
      ).toBe(false);
    });

    it('does not fire on a save-failure claim alone', () => {
      expect(
        assertsUnsavedInterruption('I could not save a memory note for future sessions.'),
      ).toBe(false);
    });

    it('does not fire on a clean success message', () => {
      expect(assertsUnsavedInterruption('Published and verified live. All done.')).toBe(false);
      expect(assertsUnsavedInterruption('')).toBe(false);
    });
  });

  describe('collectConfirmedPublishActions', () => {
    it('collects a successful publish_landing_page_changes call', () => {
      expect(
        collectConfirmedPublishActions([{ name: 'publish_landing_page_changes', result: {} }]),
      ).toEqual(['published your landing-page changes']);
    });

    it('collects a deployed generate_landing_page record', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'generate_landing_page', result: { status: 'deployed', deployedUrl: 'https://x.example.com' } },
        ]),
      ).toEqual(['deployed your landing page']);
    });

    it('de-duplicates repeated equivalent actions', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'deploy_landing_page', result: { status: 'deployed' } },
          { name: 'generate_landing_page', result: { status: 'deployed' } },
        ]),
      ).toEqual(['deployed your landing page']);
    });

    // FAIL cases: nothing may be reported as confirmed.
    it('ignores a publish call that errored', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'publish_landing_page_changes', error: 'boom' },
        ]),
      ).toEqual([]);
    });

    it('ignores a landing record that did not reach the deployed state', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'generate_landing_page', result: { status: 'failed', buildError: 'V0_CALL_TIMEOUT' } },
        ]),
      ).toEqual([]);
      expect(
        collectConfirmedPublishActions([
          { name: 'deploy_landing_page', result: { status: 'deploying', buildStatus: 'building' } },
        ]),
      ).toEqual([]);
    });

    it('ignores read-only and unrelated tools', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'list_landing_pages', result: {} },
          { name: 'get_leads', result: {} },
        ]),
      ).toEqual([]);
      expect(collectConfirmedPublishActions(null)).toEqual([]);
    });
  });

  describe('reconcileFalseFailureReport', () => {
    // The exact ENG-971 production shape.
    const ENG971_LEDGER = [
      { name: 'publish_landing_page_changes', result: {} },
      { name: 'get_deployment_status', result: { status: 'deployed', buildStatus: 'success' } },
      { name: 'save_memory', error: 'save_memory arguments failed schema validation' },
    ];

    it('appends a truthful correction when a confirmed publish is reported as lost work', () => {
      const out = reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ENG971_LEDGER);
      expect(out).not.toBe(FALSE_FAILURE_TEXT);
      expect(out.startsWith(FALSE_FAILURE_TEXT)).toBe(true);
      expect(out).toContain('published your landing-page changes');
      expect(out).toMatch(/do NOT re-run/i);
      // The bookkeeping failure must be named as the scoped, non-critical one.
      expect(out).toMatch(/bookkeeping/i);
    });

    it('is idempotent — a second pass does not stack a duplicate correction', () => {
      const once = reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ENG971_LEDGER);
      expect(reconcileFalseFailureReport(once, ENG971_LEDGER)).toBe(once);
    });

    it('omits the bookkeeping sentence when no bookkeeping call failed', () => {
      const out = reconcileFalseFailureReport(FALSE_FAILURE_TEXT, [
        { name: 'publish_landing_page_changes', result: {} },
      ]);
      expect(out).toContain('published your landing-page changes');
      expect(out).not.toMatch(/bookkeeping/i);
    });

    // FAIL cases: the guard must leave the message completely untouched.
    it('leaves a GENUINE failure report untouched (no confirmed publish)', () => {
      expect(
        reconcileFalseFailureReport(FALSE_FAILURE_TEXT, [
          { name: 'publish_landing_page_changes', error: 'upstream 502' },
          { name: 'save_memory', error: 'schema validation' },
        ]),
      ).toBe(FALSE_FAILURE_TEXT);
    });

    it('leaves a truthful success message untouched', () => {
      const text = 'Your landing page changes are published and verified live.';
      expect(reconcileFalseFailureReport(text, ENG971_LEDGER)).toBe(text);
    });

    it('leaves a scoped, accurate memory-note caveat untouched', () => {
      const text =
        'Published and verified live. One note: I could not save a memory note for future sessions.';
      expect(reconcileFalseFailureReport(text, ENG971_LEDGER)).toBe(text);
    });

    it('leaves empty or non-string content untouched', () => {
      expect(reconcileFalseFailureReport('', ENG971_LEDGER)).toBe('');
      expect(reconcileFalseFailureReport('   ', ENG971_LEDGER)).toBe('   ');
      expect(reconcileFalseFailureReport(undefined as any, ENG971_LEDGER)).toBe(undefined);
    });
  });
});
