import {
  stripUnfoundedEntityCounts,
  collectConfirmedDataWriteActions,
  reconcileFalseDataWriteFailure,
  appendConfirmedDataWriteNotice,
  collectConfirmedPublishActions,
  reconcileFalseFailureReport,
  assertsUnsavedInterruption,
} from '../utils/falseFailureReport';

/**
 * ENG-1173. Two defects on the diagnosis-agent path, both taken from production
 * session 39eb5663-126a-4ee4-bc0a-7543232b1aed ("Import Lead List to CRM").
 *
 * The persisted session carried `calledFunctions: {"add_leads_to_list": 3, ...}` —
 * a histogram of tool-call COUNTS. Three batches of 25 had succeeded, so 75 leads
 * were written. `generateDiagnosticMessage` hands that histogram to an LLM labelled
 * only "Succeeded operations", and the terminal message persisted to the user was:
 *
 *   "I have successfully added the 3 leads to your CRM list ... please retry the
 *    request to ensure any remaining tasks are completed."
 *
 * The `3` is the call count. The diagnosis agent has no record counts at all, so no
 * entity quantity it emits is ever founded — the honest fix is to remove the number,
 * not to try to correct it.
 *
 * Companion session 98b90503 shows the inversion on the same producer: 217 leads
 * written across five successful batches, closing message "Emma was unable to finish
 * adding your prospects ... You can try running the request again."
 */
describe('stripUnfoundedEntityCounts (ENG-1173)', () => {
  it('removes the batch count the production message reported as a lead count', () => {
    const prod =
      'I have successfully added the 3 leads to your CRM list "8/13/26: Founder raising." '
      + 'The final step of the process timed out, so please retry the request to ensure any '
      + 'remaining tasks are completed.';

    const out = stripUnfoundedEntityCounts(prod);

    expect(out).not.toMatch(/\b3\s+leads\b/);
    // The claim survives, only the unfounded quantity goes.
    expect(out).toMatch(/added the leads to your CRM list/i);
  });

  it('strips a bare count with no determiner', () => {
    expect(stripUnfoundedEntityCounts('I added 25 leads.')).toBe('I added the leads.');
  });

  it('strips every entity count in a message, not just the first', () => {
    const out = stripUnfoundedEntityCounts('I published 2 posts and sent 5 emails.');

    expect(out).not.toMatch(/\d/);
    expect(out).toMatch(/published the posts/i);
    expect(out).toMatch(/sent the emails/i);
  });

  it('handles thousands separators and the singular form', () => {
    expect(stripUnfoundedEntityCounts('Imported 1,204 records.')).toBe('Imported the records.');
    expect(stripUnfoundedEntityCounts('Added 1 lead.')).toBe('Added the lead.');
  });

  it('leaves numbers that are not entity quantities alone', () => {
    const keep = 'Step 2 of your plan did not run. Please try again in 5 minutes.';
    expect(stripUnfoundedEntityCounts(keep)).toBe(keep);
  });

  /**
   * "2 of 5 files" -> "2 of the files" would drop the denominator and keep the
   * numerator, turning a partial into a claim about "the files" — worse than the bug
   * being fixed. A count that is part of an N-of-M construction is left intact.
   */
  it('does not mangle an N-of-M partial', () => {
    const partial = 'I processed 2 of 5 files before stopping.';
    expect(stripUnfoundedEntityCounts(partial)).toBe(partial);
    expect(stripUnfoundedEntityCounts('Imported 75 of 97 leads.')).toBe('Imported 75 of 97 leads.');
  });

  it('leaves a message with no counts untouched', () => {
    const clean = 'The run ended before I could write the summary. Reply "continue" to resume.';
    expect(stripUnfoundedEntityCounts(clean)).toBe(clean);
  });

  it('returns non-string and empty input unchanged', () => {
    expect(stripUnfoundedEntityCounts('')).toBe('');
    expect(stripUnfoundedEntityCounts(null as any)).toBe(null);
    expect(stripUnfoundedEntityCounts(undefined as any)).toBe(undefined);
  });
});

/**
 * ENG-1173 regression guard. The widened interruption/loss vocabulary is SHARED with
 * `reconcileFalseFailureReport`, which runs at the loop edge (agentModeService, "if
 * (content && !wasCancelled)") on the MAIN AGENT's own closing prose — always-on, every
 * provider, every turn. An unscoped "unable to finish|complete" therefore reached far
 * beyond the diagnosis path and put a red correction banner on truthful messages.
 */
describe('widened vocabulary must not fire on truthful main-agent prose (ENG-1173)', () => {
  const publishLedger = [{ name: 'publish_landing_page_changes' }];

  it('leaves a truthful "published, but one sub-task did not finish" close alone', () => {
    const truthful =
      'I published your landing page. The research took longer than expected, so I was '
      + 'unable to complete the competitor analysis.';

    expect(assertsUnsavedInterruption(truthful)).toBe(false);
    expect(reconcileFalseFailureReport(truthful, publishLedger)).toBe(truthful);
  });

  it.each([
    'I was unable to complete the competitor analysis before time ran out.',
    'The run timed out and I could not finish the market research.',
    'This took longer than expected, so the summary is missing.',
  ])('no banner on truthful partial: %s', (text) => {
    expect(reconcileFalseFailureReport(text, publishLedger)).toBe(text);
  });

  it('still catches the production denial, which names a WRITE', () => {
    const prod =
      'Emma was unable to finish adding your prospects to the "POS IncentivPay Motion" '
      + 'list because the process took longer than expected.';

    expect(assertsUnsavedInterruption(prod)).toBe(true);
  });

  it('still catches the original ENG-971 shape', () => {
    const eng971 = 'The system timed out, so your changes were not saved. Please try again.';

    expect(assertsUnsavedInterruption(eng971)).toBe(true);
    expect(reconcileFalseFailureReport(eng971, publishLedger)).not.toBe(eng971);
  });
});

describe('ENG-1173 kill switch', () => {
  const ORIGINAL = process.env.AGENT_DIAGNOSIS_COUNT_GUARD;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AGENT_DIAGNOSIS_COUNT_GUARD;
    else process.env.AGENT_DIAGNOSIS_COUNT_GUARD = ORIGINAL;
  });

  /**
   * These guards rewrite/annotate user-visible text and fail SILENTLY — a false
   * positive costs the user information and surfaces only as a log line. Merging
   * deploys straight to production, so there has to be a way to stand them down from
   * config instead of waiting on a revert. Mirrors AGENT_SYNTHESIS_RESIDUE_GUARD.
   */
  it('restores exact pre-ENG-1173 behaviour when disabled', () => {
    process.env.AGENT_DIAGNOSIS_COUNT_GUARD = 'false';

    const withCount = 'I have successfully added the 3 leads to your CRM list.';
    expect(stripUnfoundedEntityCounts(withCount)).toBe(withCount);

    const falseFailure = 'The run timed out and your leads were not saved. Please try again.';
    expect(reconcileFalseDataWriteFailure(falseFailure, [{ name: 'add_leads_to_list' }]))
      .toBe(falseFailure);
    expect(appendConfirmedDataWriteNotice('Some error text.', [{ name: 'add_leads_to_list' }]))
      .toBe('Some error text.');
  });

  it('is on by default and on any value other than the literal "false"', () => {
    delete process.env.AGENT_DIAGNOSIS_COUNT_GUARD;
    expect(stripUnfoundedEntityCounts('Added 3 leads.')).toBe('Added the leads.');

    process.env.AGENT_DIAGNOSIS_COUNT_GUARD = 'true';
    expect(stripUnfoundedEntityCounts('Added 3 leads.')).toBe('Added the leads.');
  });
});

describe('reconcileFalseDataWriteFailure (ENG-1173)', () => {
  /** The 98b90503 ledger: five successful add_leads_to_list batches, one list created. */
  const CRM_LEDGER = [{ name: 'add_leads_to_list' }, { name: 'create_lead_list' }];

  it('corrects the production message that denied a completed CRM import', () => {
    const prod =
      'Emma was unable to finish adding your prospects to the "POS IncentivPay Motion" list '
      + 'because the process took longer than expected. You can try running the request again, '
      + 'or check your list in a few minutes to see if the background process completed successfully.';

    const out = reconcileFalseDataWriteFailure(prod, CRM_LEDGER);

    expect(out).not.toBe(prod);
    expect(out).toMatch(/added leads to your list/i);
    expect(out).toMatch(/do NOT re-run/i);
    // The original text is appended to, never rewritten.
    expect(out.startsWith(prod)).toBe(true);
  });

  it('stays silent when the ledger holds no confirmed data write', () => {
    const prod = 'The request timed out and nothing was saved. Please try again.';
    expect(reconcileFalseDataWriteFailure(prod, [{ name: 'get_lead_lists' }])).toBe(prod);
  });

  it('stays silent when the message makes no false-failure claim', () => {
    const truthful = 'I added your prospects to the list. The summary step ran out of time.';
    expect(reconcileFalseDataWriteFailure(truthful, CRM_LEDGER)).toBe(truthful);
  });

  it('does not fire on a write that errored', () => {
    const prod = 'The run timed out and your leads were not saved. Please try again.';
    const failed = [{ name: 'add_leads_to_list', error: 'boom' }];
    expect(reconcileFalseDataWriteFailure(prod, failed)).toBe(prod);
  });

  it('is idempotent — a second pass appends nothing', () => {
    const prod = 'The run timed out and your leads were not saved. Please try again.';
    const once = reconcileFalseDataWriteFailure(prod, CRM_LEDGER);
    expect(reconcileFalseDataWriteFailure(once, CRM_LEDGER)).toBe(once);
  });

  it('tolerates null/empty ledgers and empty content', () => {
    const prod = 'The run timed out and your leads were not saved.';
    expect(reconcileFalseDataWriteFailure(prod, null)).toBe(prod);
    expect(reconcileFalseDataWriteFailure(prod, [])).toBe(prod);
    expect(reconcileFalseDataWriteFailure('', CRM_LEDGER)).toBe('');
  });
});

/**
 * The three passes composed exactly as getDiagnosticErrorMessage composes them,
 * driven by the two real production messages and their real ledgers. This is the
 * regression the ticket exists for: whatever the individual units do, THIS is what
 * the user would now receive.
 */
describe('the wired diagnosis pipeline, on the production messages (ENG-1173)', () => {
  const runPipeline = (message: string, ledger: Array<{ name: string }>) =>
    reconcileFalseDataWriteFailure(
      reconcileFalseFailureReport(stripUnfoundedEntityCounts(message), ledger),
      ledger,
    );

  it('39eb5663: never reports the batch count as a lead count', () => {
    // calledFunctions: {"add_leads_to_list": 3} — 3 calls, 75 leads written.
    const ledger = [{ name: 'add_leads_to_list' }, { name: 'get_lead_lists' }];
    const out = runPipeline(
      'I have successfully added the 3 leads to your CRM list "8/13/26: Founder raising." '
      + 'The final step of the process timed out, so please retry the request to ensure any '
      + 'remaining tasks are completed.',
      ledger,
    );

    expect(out).not.toMatch(/\b3\s+leads\b/);
    // No invented replacement number either — the honest output carries no count.
    expect(out).not.toMatch(/\b75\s+leads\b/);
    expect(out).toMatch(/added the leads to your CRM list/i);
  });

  it('98b90503: does not tell the user a completed import failed', () => {
    // calledFunctions: {"add_leads_to_list": 5, "create_lead_list": 1} — 217 leads written.
    const ledger = [{ name: 'add_leads_to_list' }, { name: 'create_lead_list' }];
    const out = runPipeline(
      'Emma was unable to finish adding your prospects to the "POS IncentivPay Motion" list '
      + 'because the process took longer than expected. You can try running the request again, '
      + 'or check your list in a few minutes to see if the background process completed successfully.',
      ledger,
    );

    expect(out).toMatch(/added leads to your list/i);
    expect(out).toMatch(/do NOT re-run/i);
    expect(out).toMatch(/duplicate records/i);
  });

  it('leaves a truthful message with a confirmed write completely alone', () => {
    const truthful =
      'I added your prospects to the list and the import finished. '
      + 'Ask me for a summary whenever you like.';
    expect(runPipeline(truthful, [{ name: 'add_leads_to_list' }])).toBe(truthful);
  });
});

describe('appendConfirmedDataWriteNotice (ENG-1173)', () => {
  const CRM_LEDGER = [{ name: 'add_leads_to_list' }];

  /**
   * Reached whenever the diagnosis agent is unavailable — including its own 10s
   * DIAGNOSIS_TIMEOUT_MS — so this is not a rare path.
   */
  it('warns against re-running the generic fallback after a confirmed CRM write', () => {
    const fallback = 'I encountered an error processing your request. Please try sending your message again.';
    const out = appendConfirmedDataWriteNotice(fallback, CRM_LEDGER);

    expect(out.startsWith(fallback)).toBe(true);
    expect(out).toMatch(/do NOT re-run/i);
    expect(out).toMatch(/duplicate records/i);
  });

  it('appends nothing when no data write is confirmed', () => {
    const fallback = 'I encountered an error processing your request.';
    expect(appendConfirmedDataWriteNotice(fallback, [{ name: 'get_lead_lists' }])).toBe(fallback);
  });

  /**
   * A run that both published and imported must warn about BOTH. Yielding to the
   * existing banner would tell the user not to re-run the deploy while leaving the
   * duplicate-creating import unmentioned.
   */
  it('extends a publish correction instead of dropping the data-write warning', () => {
    const fallback = 'The run timed out and your changes were not saved. Please try again.';
    const ledger = [{ name: 'publish_landing_page_changes' }, { name: 'add_leads_to_list' }];

    const afterPublish = reconcileFalseFailureReport(fallback, ledger);
    expect(afterPublish).toMatch(/published your landing-page changes/i);
    expect(afterPublish).not.toMatch(/added leads to your list/i);

    const afterBoth = appendConfirmedDataWriteNotice(afterPublish, ledger);
    expect(afterBoth.startsWith(afterPublish)).toBe(true);
    expect(afterBoth).toMatch(/published your landing-page changes/i);
    expect(afterBoth).toMatch(/added leads to your list/i);
    // One banner, not two.
    expect(afterBoth.match(/⚠️ Correction/g)).toHaveLength(1);
  });

  it('is idempotent once both halves are named', () => {
    const fallback = 'The run timed out and your changes were not saved. Please try again.';
    const ledger = [{ name: 'publish_landing_page_changes' }, { name: 'add_leads_to_list' }];
    const once = appendConfirmedDataWriteNotice(reconcileFalseFailureReport(fallback, ledger), ledger);

    expect(appendConfirmedDataWriteNotice(once, ledger)).toBe(once);
    expect(reconcileFalseDataWriteFailure(once, ledger)).toBe(once);
  });

  it('tolerates empty content and a null ledger', () => {
    expect(appendConfirmedDataWriteNotice('', CRM_LEDGER)).toBe('');
    expect(appendConfirmedDataWriteNotice('some text', null)).toBe('some text');
  });
});

describe('data-write confirmation must not widen the publish gate (ENG-1173)', () => {
  /**
   * `collectConfirmedPublishActions` decides more than wording: at
   * agentModeController.ts it drives `mayHavePublished`, which decides whether a
   * failed SCHEDULED run may be requeued at all. Teaching it about CRM writes would
   * silently disable a schedule's auto-recovery — exactly the over-reach the module
   * header warns about. The data-write set is therefore separate and message-only.
   */
  it('leaves the scheduled-requeue gate blind to CRM writes', () => {
    expect(collectConfirmedPublishActions([{ name: 'add_leads_to_list' }])).toEqual([]);
    expect(collectConfirmedPublishActions([{ name: 'create_lead_list' }])).toEqual([]);
  });

  it('still reports CRM writes on the message-only path', () => {
    expect(collectConfirmedDataWriteActions([{ name: 'add_leads_to_list' }]))
      .toEqual(['added leads to your list']);
  });

  it('de-duplicates repeated calls to the same write tool', () => {
    const repeated = [
      { name: 'add_leads_to_list' },
      { name: 'add_leads_to_list' },
      { name: 'add_leads_to_list' },
    ];
    expect(collectConfirmedDataWriteActions(repeated)).toEqual(['added leads to your list']);
  });

  it('ignores read-only lookups and unknown tools', () => {
    expect(collectConfirmedDataWriteActions([{ name: 'get_lead_lists' }, { name: 'nope' }]))
      .toEqual([]);
  });

  it('covers the other duplicate-unsafe writes found in the tool registry', () => {
    const covered = [
      'add_lead_engagement',
      'enrich_leads_execute',
      'enrich_lead_custom',
      'create_google_doc',
      'create_google_sheet',
      'create_knowledge_base',
    ];
    for (const name of covered) {
      expect(collectConfirmedDataWriteActions([{ name }])).toHaveLength(1);
    }
  });

  /**
   * Each exclusion is a decision, not an oversight — see the block comment beside
   * CONFIRMED_DATA_WRITE_TOOLS. Drafts are cheap to re-run, deprecated tools are on
   * their way out, updates/deletes converge instead of duplicating, and
   * import_leads_from_search has known count defects (ENG-1002 / ENG-1068).
   */
  it('stays out of drafts, deprecated tools, updates and deletes', () => {
    const excluded = [
      'import_leads_from_search',
      'create_blog_article',
      'create_social_media_posts',
      'create_task_from_prompt',
      'create_image_task_from_prompt',
      'update_lead',
      'update_lead_list',
      'delete_leads',
      'delete_lead_list',
    ];
    for (const name of excluded) {
      expect(collectConfirmedDataWriteActions([{ name }])).toEqual([]);
    }
  });
});
