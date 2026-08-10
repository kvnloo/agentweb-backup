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
  ledgerFromSucceededFunctions,
  diffSucceededFunctions,
  appendConfirmedPublishNotice,
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

    it('still fires on a not-saved claim that is not negated', () => {
      expect(
        assertsUnsavedInterruption(
          'The session timed out. Your changes were not saved due to a validation error.',
        ),
      ).toBe(true);
    });

    // FAIL cases: a NEGATED loss is a truthful reassurance, not the ENG-971 pattern.
    it('does not fire when the message says no work was lost', () => {
      expect(
        assertsUnsavedInterruption(
          'There was a brief connection interruption, but no work was lost.',
        ),
      ).toBe(false);
      expect(
        assertsUnsavedInterruption(
          'The session timed out; however, none of your work was lost.',
        ),
      ).toBe(false);
    });

    it('does not fire on a clean success message', () => {
      expect(assertsUnsavedInterruption('Published and verified live. All done.')).toBe(false);
      expect(assertsUnsavedInterruption('')).toBe(false);
    });

    // The message is written by an LLM, so the guard cannot key off one sentence.
    // These are rephrasings of the SAME claim that the first pass missed entirely.
    describe('semantic variants of the same claim', () => {
      const SHOULD_FIRE = [
        'The request timed out, so the update did not go through. Please try again.',
        'The run was cut short before the changes could be applied.',
        'Unfortunately the operation timed out and nothing was published.',
        'The session ended unexpectedly, so your edits may not have persisted.',
        'The system ran out of time and could not complete the deployment.',
        'I hit an error partway through; none of the changes made it to production.',
        'The run did not finish, so your changes were never applied.',
        'The connection dropped and the post was not sent.',
      ];

      it.each(SHOULD_FIRE)('fires on: %s', (text) => {
        expect(assertsUnsavedInterruption(text)).toBe(true);
      });

      // FAIL cases: each pairs an interruption with a TRUTHFUL, correctly-scoped
      // caveat. Widening the loss half must not swallow these.
      const SHOULD_NOT_FIRE = [
        'The run was cut short before I could save a memory note, but your page is live.',
        'The session ended unexpectedly. Everything you asked for was published first.',
        'The run ran out of time while drafting the follow-up email; nothing else was affected.',
        'The lookup timed out, so I could not complete the competitor comparison.',
        'The run was cut short, but none of your changes were lost.',
        'The session timed out partway through. Your landing page had already gone live.',
      ];

      it.each(SHOULD_NOT_FIRE)('stays silent on: %s', (text) => {
        expect(assertsUnsavedInterruption(text)).toBe(false);
      });
    });
  });

  describe('collectConfirmedPublishActions', () => {
    it('collects a successful publish_landing_page_changes call', () => {
      expect(
        collectConfirmedPublishActions([{ name: 'publish_landing_page_changes', result: {} }]),
      ).toEqual(['published your landing-page changes']);
    });

    // generate_landing_page is NO LONGER a confirmed publish, even with a deployed
    // record: it produces a draft plus a preview. It was removed once this same set
    // began gating scheduled auto-retry, where over-reach silently disables a schedule.
    it('does not treat a deployed generate_landing_page record as a publish', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'generate_landing_page', result: { status: 'deployed', deployedUrl: 'https://x.example.com' } },
        ]),
      ).toEqual([]);
    });

    it('de-duplicates repeated equivalent actions', () => {
      expect(
        collectConfirmedPublishActions([
          { name: 'deploy_landing_page', result: { status: 'deployed' } },
          { name: 'deploy_landing_page', result: { status: 'deployed' } },
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

  // The in-loop ledger (toolCalls[]) does not exist on the error path: when the turn
  // THROWS — a 600s generation timeout in the production session — the controller only
  // has the persisted session. `calledFunctions` there is the successful-call histogram
  // (toolDispatch flushes successes and failures to separate counters, per iteration),
  // which is exactly the ledger this guard needs.
  describe('ledgerFromSucceededFunctions', () => {
    it('turns the session success histogram into ledger entries', () => {
      expect(
        ledgerFromSucceededFunctions({ publish_landing_page_changes: 1, get_deployment_status: 2 }),
      ).toEqual([
        { name: 'publish_landing_page_changes' },
        { name: 'get_deployment_status' },
      ]);
    });

    it('drops tools whose success count is zero or negative', () => {
      expect(
        ledgerFromSucceededFunctions({ publish_landing_page_changes: 0, generate_landing_page: -1 }),
      ).toEqual([]);
    });

    it('returns an empty ledger for missing or malformed input', () => {
      expect(ledgerFromSucceededFunctions(null)).toEqual([]);
      expect(ledgerFromSucceededFunctions(undefined)).toEqual([]);
      expect(ledgerFromSucceededFunctions({} as any)).toEqual([]);
      expect(ledgerFromSucceededFunctions({ publish_landing_page_changes: 'yes' } as any)).toEqual([]);
    });

    it('feeds the guard the production session 7b4895fd shape', () => {
      // Successes flushed before the 600s timeout threw: the publish DID land.
      // generate_landing_page also succeeded, but it only produced a DRAFT, so it
      // must not appear as a deploy.
      const ledger = ledgerFromSucceededFunctions({
        publish_landing_page_changes: 1,
        generate_landing_page: 1,
        get_deployment_status: 2,
        save_memory: 1,
      });

      expect(collectConfirmedPublishActions(ledger)).toEqual([
        'published your landing-page changes',
      ]);
      expect(
        reconcileFalseFailureReport(
          'The system timed out while attempting to update the shared /api/capture route, '
          + 'so your changes were not saved. Please try your request again.',
          ledger,
        ),
      ).toContain('do NOT re-run it');
    });

    it('stays silent for a run whose successes include no publish', () => {
      const ledger = ledgerFromSucceededFunctions({ get_leads: 5, you_search_web: 2 });
      expect(collectConfirmedPublishActions(ledger)).toEqual([]);
      expect(reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ledger)).toBe(FALSE_FAILURE_TEXT);
    });
  });

  // A landing page is not the only thing a user would wrongly re-run. A duplicate
  // social post or a duplicate outreach email is just as unrecoverable.
  describe('confirmed publish set beyond landing pages', () => {
    it.each([
      ['post_on_connected_account', 'posted to your connected account'],
      ['post_thread', 'posted your thread'],
      ['send_email_to_lead', 'sent your email'],
      ['send_email_from_sender', 'sent your email'],
      ['send_dm', 'sent your direct message'],
    ])('%s confirms a real send/post', (tool, label) => {
      const ledger = ledgerFromSucceededFunctions({ [tool]: 1 });
      expect(collectConfirmedPublishActions(ledger)).toEqual([label]);
      expect(reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ledger)).toContain(label);
    });

    // FAIL case: a draft is not a deploy. These were in the set until review; once
    // the same set also gated scheduled auto-retry, over-reach stopped being cosmetic
    // and started silently disabling schedules.
    it.each(['generate_landing_page', 'duplicate_landing_page'])(
      '%s produces a draft, not a confirmed publish',
      (tool) => {
        const ledger = ledgerFromSucceededFunctions({ [tool]: 1 });
        expect(collectConfirmedPublishActions(ledger)).toEqual([]);
        expect(reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ledger)).toBe(FALSE_FAILURE_TEXT);
      },
    );

    // FAIL case: twitter_manage_post multiplexes create/delete/read behind ONE
    // name. On the diagnosis path only the name survives, so a successful DELETE
    // would be reported as "posted" — the guard must not claim what it cannot see.
    it('excludes multi-action tools whose success does not prove a publish', () => {
      const ledger = ledgerFromSucceededFunctions({ twitter_manage_post: 1 });
      expect(collectConfirmedPublishActions(ledger)).toEqual([]);
      expect(reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ledger)).toBe(FALSE_FAILURE_TEXT);
    });
  });

  /**
   * calledFunctions accumulates for the LIFE of the session, so reading it raw
   * attributes an earlier turn's (or an earlier RESUMED RUN's) success to the current
   * failure. On the scheduled path that meant an inherited publish could suppress the
   * requeue of an unrelated failure and silently end a schedule's auto-recovery.
   */
  describe('diffSucceededFunctions', () => {
    it('keeps only what increased since the snapshot', () => {
      expect(
        diffSucceededFunctions(
          { publish_landing_page_changes: 1, get_leads: 2 },
          { publish_landing_page_changes: 1, get_leads: 5, send_dm: 1 },
        ),
      ).toEqual({ get_leads: 3, send_dm: 1 });
    });

    it('hides a publish that belongs to an earlier turn', () => {
      const before = { publish_landing_page_changes: 1 };
      const after = { publish_landing_page_changes: 1, you_search_web: 4 };
      const ledger = ledgerFromSucceededFunctions(diffSucceededFunctions(before, after));

      expect(collectConfirmedPublishActions(ledger)).toEqual([]);
      expect(reconcileFalseFailureReport(FALSE_FAILURE_TEXT, ledger)).toBe(FALSE_FAILURE_TEXT);
    });

    it('still surfaces a publish that happened in THIS turn', () => {
      const ledger = ledgerFromSucceededFunctions(
        diffSucceededFunctions({ get_leads: 2 }, { get_leads: 2, publish_landing_page_changes: 1 }),
      );
      expect(collectConfirmedPublishActions(ledger)).toEqual(['published your landing-page changes']);
    });

    it('counts a SECOND publish in a session that already had one', () => {
      const ledger = ledgerFromSucceededFunctions(
        diffSucceededFunctions({ publish_landing_page_changes: 1 }, { publish_landing_page_changes: 2 }),
      );
      expect(collectConfirmedPublishActions(ledger)).toEqual(['published your landing-page changes']);
    });

    it('treats a missing baseline as nothing-known-before', () => {
      expect(diffSucceededFunctions(null, { publish_landing_page_changes: 1 }))
        .toEqual({ publish_landing_page_changes: 1 });
      expect(diffSucceededFunctions(undefined, null)).toEqual({});
      expect(diffSucceededFunctions({ a: 1 }, undefined)).toEqual({});
    });

    it('ignores malformed counts rather than trusting them', () => {
      expect(diffSucceededFunctions({ a: 'x' } as any, { a: 2, b: 'y' } as any)).toEqual({ a: 2 });
    });
  });

  // The diagnosis agent can be unavailable — it races a timeout and returns null.
  // The static fallback that replaces it still says "please try sending your
  // message again", which after a landed publish is the same double-deploy advice
  // that made ENG-971 harmful. There is no prose to judge here, so the caller
  // decides and this appends unconditionally on a confirmed publish.
  describe('appendConfirmedPublishNotice', () => {
    const GENERIC = 'I encountered an error processing your request. Please try sending your message again.';

    it('adds the true outcome to the generic fallback after a confirmed publish', () => {
      const out = appendConfirmedPublishNotice(
        GENERIC,
        ledgerFromSucceededFunctions({ publish_landing_page_changes: 1 }),
      );
      expect(out).toContain(GENERIC);
      expect(out).toContain('published your landing-page changes');
      expect(out).toContain('do NOT re-run it');
    });

    it('leaves the fallback alone when the run published nothing', () => {
      expect(appendConfirmedPublishNotice(GENERIC, ledgerFromSucceededFunctions({ get_leads: 1 })))
        .toBe(GENERIC);
      expect(appendConfirmedPublishNotice(GENERIC, [])).toBe(GENERIC);
      expect(appendConfirmedPublishNotice(GENERIC, null)).toBe(GENERIC);
    });

    it('is idempotent and leaves empty content alone', () => {
      const ledger = ledgerFromSucceededFunctions({ publish_landing_page_changes: 1 });
      const once = appendConfirmedPublishNotice(GENERIC, ledger);
      expect(appendConfirmedPublishNotice(once, ledger)).toBe(once);
      expect(appendConfirmedPublishNotice('', ledger)).toBe('');
    });
  });
});
