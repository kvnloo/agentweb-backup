/**
 * Tests for the finalize guard (ENG-143 / ENG-135 / ENG-124) — the claimed-vs-
 * executed check at the loop edge. Generalizes the shipped ENG-104 single-tool
 * pattern: the final assistant message may not claim a completed high-harm
 * action (email sent, task created, post published, schedule created, CRM
 * saved, asset generated) that the run's tool ledger does not show as a
 * SUCCESSFUL execution.
 *
 * Contract under test (see finalizeGuard.ts):
 *  - cheap lexicon prefilter → judge call ONLY on a hit (zero LLM cost otherwise)
 *  - deterministic ledger match (status==='success' && !toolResultError(result);
 *    asset claims additionally require mediaGenProducedAsset)
 *  - mismatch → ONE corrective turn → re-check → still mismatched → visible
 *    truthful correction appended + claimMismatch=true (verdict reason)
 *  - judge failure → deliver UNCHANGED + loud claim_check_error (never a silent
 *    rewrite, never a blocked delivery)
 */

import {
  runFinalizeGuard,
  prefilterClaimClasses,
  buildCorrectionSystemNote,
  buildFinalizeJudgePrompt,
  type FinalizeGuardPorts,
  type FinalizeLedgerEntry,
  type JudgedClaim,
} from '../finalizeGuard';
import { toolResultError } from '../../../../utils/toolResultError';
import { mediaGenProducedAsset } from '../toolDispatch';

/** Build a full port set with overridable judge/correction behavior. */
function makePorts(overrides: Partial<FinalizeGuardPorts> = {}): {
  ports: FinalizeGuardPorts;
  judge: jest.Mock;
  correct: jest.Mock;
  claimCheckErrors: unknown[];
} {
  const claimCheckErrors: unknown[] = [];
  const judge = jest.fn<Promise<JudgedClaim[]>, [string, readonly string[]]>()
    .mockResolvedValue([]);
  const correct = jest.fn<Promise<string>, [{ finalText: string; systemNote: string }]>()
    .mockResolvedValue('Corrected reply.');
  const ports: FinalizeGuardPorts = {
    judgeExtractClaims: judge as any,
    requestCorrection: correct as any,
    toolResultError,
    mediaGenProducedAsset,
    recordClaimCheckError: (err) => claimCheckErrors.push(err),
    ...overrides,
  };
  return { ports, judge, correct, claimCheckErrors };
}

const CLAIMING_TEXT = "Done! I've sent the email to the client with the report attached.";

describe('prefilterClaimClasses', () => {
  it('flags a completed email-send claim', () => {
    expect(prefilterClaimClasses(CLAIMING_TEXT)).toContain('email_sent');
  });

  it('flags a completed asset-generation claim', () => {
    expect(prefilterClaimClasses('I generated 3 images for the campaign and saved them.'))
      .toContain('asset_generated');
  });

  it('returns empty for a reply that claims no completed action', () => {
    expect(prefilterClaimClasses('Here are three subject-line options for you to review.'))
      .toEqual([]);
  });

  // ENG-143 gap: the ticket's own Filipe/competitor-research example — "saved
  // the setup for future sessions" — had no matching claim class at all.
  it('flags a completed settings/setup-persistence claim (the ENG-143 "saved the setup" example)', () => {
    expect(prefilterClaimClasses("I've saved the setup for future sessions, so you won't need to repeat this."))
      .toContain('settings_saved');
  });

  it('flags a "remembered your preferences" persistence claim', () => {
    expect(prefilterClaimClasses('Got it — I remembered your preferences for next time.'))
      .toContain('settings_saved');
  });

  // ENG-143 gap: the ticket's own literal example — "the test task landed in
  // ClickUp" — used "landed", not created/updated/added/completed, so it
  // never matched the original task_created_or_updated regex.
  it('flags "landed in ClickUp" as a completed task claim (the ENG-143 literal example)', () => {
    expect(prefilterClaimClasses('The test task landed in ClickUp.'))
      .toContain('task_created_or_updated');
  });

  it('flags "is now in ClickUp" as a completed task claim', () => {
    expect(prefilterClaimClasses("I've put together the competitor research task — it's now in ClickUp."))
      .toContain('task_created_or_updated');
  });
});

describe('runFinalizeGuard', () => {
  const emptyLedger: FinalizeLedgerEntry[] = [];

  it('no lexicon hit → no_claims, judge is never called, text unchanged', async () => {
    const { ports, judge, correct } = makePorts();
    const outcome = await runFinalizeGuard({
      finalText: 'Here are three subject-line options for you to review.',
      ledger: emptyLedger,
      ports,
    });
    expect(outcome.action).toBe('no_claims');
    expect(outcome.finalText).toBe('Here are three subject-line options for you to review.');
    expect(outcome.claimMismatch).toBe(false);
    expect(judge).not.toHaveBeenCalled();
    expect(correct).not.toHaveBeenCalled();
  });

  it('judge throws → message delivered UNCHANGED + claim_check_error recorded (failure path)', async () => {
    const { ports, correct, claimCheckErrors } = makePorts({
      judgeExtractClaims: jest.fn().mockRejectedValue(new Error('judge unavailable')),
    });
    const outcome = await runFinalizeGuard({
      finalText: CLAIMING_TEXT,
      ledger: emptyLedger,
      ports,
    });
    expect(outcome.action).toBe('judge_error');
    expect(outcome.finalText).toBe(CLAIMING_TEXT);
    expect(outcome.claimMismatch).toBe(false);
    expect(correct).not.toHaveBeenCalled();
    expect(claimCheckErrors).toHaveLength(1);
  });

  it('email_sent claim with NO successful email tool in ledger → corrective turn issued (failure path)', async () => {
    const { ports, judge, correct } = makePorts();
    judge
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]); // initial check
    correct.mockResolvedValue('I was unable to complete the email step — the send did not succeed. Want me to retry?');

    const outcome = await runFinalizeGuard({
      finalText: CLAIMING_TEXT,
      ledger: emptyLedger,
      ports,
    });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0][0].systemNote).toContain('no successful email_sent');
    // corrected text has no completed-action claim → resolves clean
    expect(outcome.action).toBe('corrected');
    expect(outcome.finalText).toBe('I was unable to complete the email step — the send did not succeed. Want me to retry?');
    expect(outcome.claimMismatch).toBe(false);
  });

  it('detectOnly (shadow): mismatch found → detected_mismatch, text unchanged, correction port never called (ENG-2150 fix)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]); // initial check

    const outcome = await runFinalizeGuard({
      finalText: CLAIMING_TEXT,
      ledger: emptyLedger,
      ports,
      detectOnly: true,
    });

    expect(correct).not.toHaveBeenCalled();
    expect(outcome.action).toBe('detected_mismatch');
    expect(outcome.finalText).toBe(CLAIMING_TEXT);
    expect(outcome.claimMismatch).toBe(true);
    expect(outcome.mismatchedClaimClasses).toEqual(['email_sent']);
  });

  it('detectOnly (shadow): a backed claim is still clean, and the judge alone decides — no correction attempted either way', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);

    const outcome = await runFinalizeGuard({
      finalText: CLAIMING_TEXT,
      ledger: [{ toolName: 'send_email', status: 'success' }],
      ports,
      detectOnly: true,
    });

    expect(correct).not.toHaveBeenCalled();
    expect(outcome.action).toBe('clean');
    expect(outcome.claimMismatch).toBe(false);
  });

  it('corrective turn does NOT resolve → visible correction appended + claimMismatch (failure path)', async () => {
    const { ports, judge, correct } = makePorts();
    const stillLying = 'The email was sent earlier today as requested.';
    judge
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]) // initial check
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]); // re-check on corrected text
    correct.mockResolvedValue(stillLying);

    const outcome = await runFinalizeGuard({
      finalText: CLAIMING_TEXT,
      ledger: emptyLedger,
      ports,
    });

    expect(outcome.action).toBe('appended_correction');
    expect(outcome.finalText.startsWith(stillLying)).toBe(true);
    expect(outcome.finalText).toContain('Correction');
    expect(outcome.finalText).toContain('email_sent');
    expect(outcome.claimMismatch).toBe(true);
    expect(outcome.mismatchedClaimClasses).toEqual(['email_sent']);
    expect(correct).toHaveBeenCalledTimes(1); // exactly ONE corrective turn
  });

  it('claim backed by a successful send_email ledger entry → clean, no correction (happy path)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'send_email', status: 'success', result: { success: true, messageId: 'm-1' } },
    ];

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger, ports });

    expect(outcome.action).toBe('clean');
    expect(outcome.finalText).toBe(CLAIMING_TEXT);
    expect(outcome.claimMismatch).toBe(false);
    expect(correct).not.toHaveBeenCalled();
  });

  it('a send_email "success" that ENCODES a failure does not back the claim', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);
    correct.mockResolvedValue('The email could not be delivered — the provider rejected it.');
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'send_email', status: 'success', result: { success: false, error: 'SMTP rejected' } },
    ];

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger, ports });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(outcome.action).toBe('corrected');
  });

  it('a FAILED send_email ledger entry does not back the claim', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);
    correct.mockResolvedValue('The email step failed and nothing was delivered.');
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'send_email', status: 'error' },
    ];

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger, ports });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(outcome.action).toBe('corrected');
  });

  it('asset claim: a generate_image confirmation-gate pause (no asset) does not back asset_generated', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'asset_generated', statement: 'quoted from the reply' }]);
    correct.mockResolvedValue('No new visuals exist yet — the run paused for your confirmation before producing anything.');
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'generate_image', status: 'success', result: { success: true, awaitingUserConfirmation: true } },
    ];

    const outcome = await runFinalizeGuard({
      finalText: 'I generated the image and saved it to your assets.',
      ledger,
      ports,
    });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(outcome.action).toBe('corrected');
    // Regression guard: a KNOWN media-gen tool failing the strict matcher is a
    // confident exclusion (xCures 76x-images case), NOT an ambiguous
    // coverage-gap match — must never get downgraded to ambiguous_unmatched.
    expect(outcome.ambiguousClaimClasses).toEqual([]);
  });

  it('asset claim: a real generate_image asset backs asset_generated (happy path)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'asset_generated', statement: 'quoted from the reply' }]);
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'generate_image', status: 'success', result: { success: true, imageUrl: 'https://s3/img.png' } },
    ];

    const outcome = await runFinalizeGuard({
      finalText: 'I generated the image and saved it to your assets.',
      ledger,
      ports,
    });

    expect(outcome.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });

  it('correction call throws → visible correction appended to the ORIGINAL text + claim_check_error', async () => {
    const { ports, judge, claimCheckErrors } = makePorts({
      requestCorrection: jest.fn().mockRejectedValue(new Error('correction model down')),
    });
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: emptyLedger, ports });

    expect(outcome.action).toBe('appended_correction');
    expect(outcome.finalText.startsWith(CLAIMING_TEXT)).toBe(true);
    expect(outcome.finalText).toContain('Correction');
    expect(outcome.claimMismatch).toBe(true);
    expect(claimCheckErrors).toHaveLength(1);
  });

  it('re-check judge throws → conservative: correction appended + claim_check_error', async () => {
    const { ports, judge, correct, claimCheckErrors } = makePorts();
    const stillLying = 'The email was sent earlier today as requested.';
    judge
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }])
      .mockRejectedValueOnce(new Error('judge flake on re-check'));
    correct.mockResolvedValue(stillLying);

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: emptyLedger, ports });

    expect(outcome.action).toBe('appended_correction');
    expect(outcome.claimMismatch).toBe(true);
    expect(claimCheckErrors).toHaveLength(1);
  });

  it('settings_saved claim with NO successful memory/config tool in ledger → corrective turn (ENG-143 gap)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved', statement: 'quoted from the reply' }]);
    correct.mockResolvedValue("I wasn't able to save that setup — nothing was persisted this session. Want me to try again?");

    const outcome = await runFinalizeGuard({
      finalText: "Done! I've saved the setup for future sessions.",
      ledger: emptyLedger,
      ports,
    });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0][0].systemNote).toContain('no successful settings_saved');
    expect(outcome.action).toBe('corrected');
  });

  it('settings_saved claim backed by a successful save_memory ledger entry → clean (happy path)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved', statement: 'quoted from the reply' }]);
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'save_memory', status: 'success', result: { success: true } },
    ];

    const outcome = await runFinalizeGuard({
      finalText: "Done! I've saved the setup for future sessions.",
      ledger,
      ports,
    });

    expect(outcome.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });

  it('settings_saved claim backed by a successful update_brand_guidelines ledger entry → clean', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved', statement: 'quoted from the reply' }]);
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'update_brand_guidelines', status: 'success', result: { success: true } },
    ];

    const outcome = await runFinalizeGuard({
      finalText: "I've updated and saved your brand setup.",
      ledger,
      ports,
    });

    expect(outcome.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });

  it('"landed in ClickUp" claim end-to-end: no ClickUp task tool exists → unbacked → corrective turn (ENG-143 literal example)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated', statement: 'quoted from the reply' }]);
    correct.mockResolvedValue('The task was not actually created in ClickUp this session — I do not have a tool to do that yet. I can create it as an internal task instead, or you can add it manually.');

    const outcome = await runFinalizeGuard({
      finalText: 'The test task landed in ClickUp.',
      ledger: emptyLedger, // no ClickUp task-creation tool exists in the schema today
      ports,
    });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0][0].systemNote).toContain('no successful task_created_or_updated');
    expect(outcome.action).toBe('corrected');
  });

  it('task claim backed by a successful create_task_from_prompt ledger entry → clean (happy path)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated', statement: 'quoted from the reply' }]);
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'create_task_from_prompt', status: 'success', result: { success: true, taskId: 't-1' } },
    ];

    const outcome = await runFinalizeGuard({
      finalText: 'The task was created and is now in your queue.',
      ledger,
      ports,
    });

    expect(outcome.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });

  it('judge returning unknown claim classes ignores them (never crashes the guard)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([
      { claimClass: 'made_up_class' as any },
    ]);

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: emptyLedger, ports });

    expect(outcome.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });
});

describe('runFinalizeGuard — ambiguous coverage-gap matches (risk reduction, ENG-143)', () => {
  const emptyLedger: FinalizeLedgerEntry[] = [];

  // Our tool-matchers are pattern-based (prefix + keyword) and will always
  // have coverage gaps for tools that don't follow the expected naming
  // convention. Correcting a TRUE claim because of a matcher miss is worse
  // than the original bug (it visibly contradicts a correct statement), so a
  // successful tool call that loosely matches the claim's keyword — even
  // without hitting the strict prefix pattern — should hold off correction
  // and just surface the gap for review instead of rewriting the message.
  it('a claim with only a LOOSE tool-name match (no strict match) is left unchanged: action ambiguous_unmatched', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated', statement: 'quoted from the reply' }]);
    // "sync_task_from_calendar" contains "task" but doesn't start with
    // create_/update_/manage_/add_/execute_ — strict matcher misses it.
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'sync_task_from_calendar', status: 'success', result: { success: true } },
    ];

    const outcome = await runFinalizeGuard({
      finalText: 'The task was created and is now in your queue.',
      ledger,
      ports,
    });

    expect(outcome.action).toBe('ambiguous_unmatched');
    expect(outcome.finalText).toBe('The task was created and is now in your queue.');
    expect(outcome.claimMismatch).toBe(false);
    expect(outcome.ambiguousClaimClasses).toEqual(['task_created_or_updated']);
    expect(correct).not.toHaveBeenCalled();
  });

  it('a claim with NO match at all (not even loose) still gets corrected as before (no regression)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated', statement: 'quoted from the reply' }]);
    correct.mockResolvedValue('The task was not actually created this session.');

    const outcome = await runFinalizeGuard({
      finalText: 'The test task landed in ClickUp.',
      ledger: emptyLedger,
      ports,
    });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(outcome.action).toBe('corrected');
    expect(outcome.ambiguousClaimClasses).toEqual([]);
  });

  it('mixed: a confidently-unbacked class still corrects, an ambiguous class in the same reply is left out of the correction and reported separately', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([
      { claimClass: 'email_sent', statement: 'quoted from the reply' },
      { claimClass: 'task_created_or_updated', statement: 'quoted from the reply' },
    ]);
    correct.mockResolvedValue('I was not able to send the email this session.');
    const ledger: FinalizeLedgerEntry[] = [
      // email_sent: no matching tool at all → confidently unbacked
      { toolName: 'sync_task_from_calendar', status: 'success', result: { success: true } }, // loose task match only
    ];

    const outcome = await runFinalizeGuard({
      finalText: "Done! I've sent the email and the task landed in ClickUp.",
      ledger,
      ports,
    });

    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0][0].systemNote).toContain('no successful email_sent');
    expect(correct.mock.calls[0][0].systemNote).not.toContain('task_created_or_updated');
    expect(outcome.ambiguousClaimClasses).toEqual(['task_created_or_updated']);
  });

  it('strict match still wins cleanly when both strict and loose would match (no behavior change for the common case)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);
    const ledger: FinalizeLedgerEntry[] = [
      { toolName: 'send_email', status: 'success', result: { success: true, messageId: 'm-1' } },
    ];

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger, ports });

    expect(outcome.action).toBe('clean');
    expect(outcome.ambiguousClaimClasses).toEqual([]);
    expect(correct).not.toHaveBeenCalled();
  });
});

describe('buildCorrectionSystemNote', () => {
  it('names every mismatched claim class and demands the true outcome', () => {
    const note = buildCorrectionSystemNote(['email_sent', 'post_published'] as any);
    expect(note).toContain('no successful email_sent, post_published');
    expect(note.toLowerCase()).toContain('restate the true outcome');
  });
});

/**
 * ENG-2459: the 2026-09-28..10-12 shadow window flagged 52 runs, none of them a completed action without a
 * backing call. Real tools were missing from the matchers, and the judge reported classes the lexicon never
 * raised or claims with nothing quoted.
 */
describe('real tools back their claim class (ENG-2459)', () => {
  const ok = (toolName: string): FinalizeLedgerEntry => ({ toolName, status: 'success', result: { success: true } });

  it.each([
    ['notify_session sends the session email', "Done! I've sent the email to the client.", 'email_sent', 'notify_session'],
    ['add_gtm_work_items creates the tasks', 'I added 3 tasks to your plan.', 'task_created_or_updated', 'add_gtm_work_items'],
    ['update_gtm_work_item updates a task', 'I updated the task for the launch.', 'task_created_or_updated', 'update_gtm_work_item'],
    ['post_on_connected_account publishes', 'The LinkedIn post was published.', 'post_published', 'post_on_connected_account'],
    ['create_html_file produces the asset', 'I created the landing page and generated the HTML asset.', 'asset_generated', 'create_html_file'],
    ['update_html_file produces the asset', 'I generated the revised HTML asset.', 'asset_generated', 'update_html_file'],
    ['create_html_from_template produces the asset', 'I generated the HTML asset from your template.', 'asset_generated', 'create_html_from_template'],
    ['create_social_media_posts produces the asset', 'I created the asset for each post.', 'asset_generated', 'create_social_media_posts'],
    ['update_knowledge_base_file saves the file', 'I saved the brand documents to the Knowledge Base for later.', 'settings_saved', 'update_knowledge_base_file'],
    ['create_knowledge_base saves the file', 'I stored the notes in the new Knowledge Base for later.', 'settings_saved', 'create_knowledge_base'],
    ['attach_knowledge_base_files saves the file', 'I saved the attachments to the Knowledge Base for later.', 'settings_saved', 'attach_knowledge_base_files'],
  ])('%s', async (_name, finalText, claimClass, toolName) => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: claimClass as any, statement: 'quoted from the reply' }]);

    const outcome = await runFinalizeGuard({ finalText, ledger: [ok(toolName)], ports });

    expect(prefilterClaimClasses(finalText)).toContain(claimClass);
    expect(outcome.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });

  it('a FAILED notify_session does not back an email claim', async () => {
    const { ports, judge } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'quoted from the reply' }]);

    const outcome = await runFinalizeGuard({
      finalText: CLAIMING_TEXT,
      ledger: [{ toolName: 'notify_session', status: 'error', result: { error: 'smtp down' } }],
      ports,
      detectOnly: true,
    });

    expect(outcome.action).toBe('detected_mismatch');
  });

  it('a read-only knowledge-base call does not back a "saved" claim', async () => {
    const { ports, judge } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved', statement: 'quoted from the reply' }]);

    const outcome = await runFinalizeGuard({
      finalText: 'I saved the brand documents to the Knowledge Base for later.',
      ledger: [ok('list_knowledge_base_files'), ok('read_knowledge_base_files')],
      ports,
      detectOnly: true,
    });

    expect(outcome.action).toBe('detected_mismatch');
  });

  it('a paused media-gen call still does not back an asset claim, even next to an HTML file call that failed', async () => {
    const { ports, judge } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'asset_generated', statement: 'quoted from the reply' }]);

    const outcome = await runFinalizeGuard({
      finalText: 'I generated 4 images for the ad set.',
      ledger: [
        { toolName: 'generate_image', status: 'success', result: { awaitingUserConfirmation: true } },
        { toolName: 'create_html_file', status: 'error', result: { error: 'failed' } },
      ],
      ports,
      detectOnly: true,
    });

    expect(outcome.action).toBe('detected_mismatch');
  });
});

describe('judge output must be about a candidate class and quote a statement (ENG-2459)', () => {
  it.each([
    ['a class the lexicon never raised', [{ claimClass: 'schedule_created', statement: 'the schedule is active' }]],
    ['a claim with no statement', [{ claimClass: 'email_sent' }]],
    ['a claim with an empty statement', [{ claimClass: 'email_sent', statement: '' }]],
    ['a claim with a whitespace-only statement', [{ claimClass: 'email_sent', statement: '   ' }]],
  ])('ignores %s', async (_name, claims) => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce(claims as JudgedClaim[]);

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: [], ports });

    expect(prefilterClaimClasses(CLAIMING_TEXT)).toEqual(['email_sent']);
    expect(outcome.action).toBe('clean');
    expect(outcome.claimMismatch).toBe(false);
    expect(correct).not.toHaveBeenCalled();
  });

  it('still corrects a real mismatch that is a candidate class and quotes its statement', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent', statement: "I've sent the email" }]);
    correct.mockResolvedValue('The email was not sent. Want me to retry?');

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: [], ports });

    expect(outcome.action).toBe('corrected');
    expect(correct).toHaveBeenCalledTimes(1);
  });

  it('the re-check applies the same rule to the corrected text', async () => {
    const { ports, judge, correct } = makePorts();
    judge
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: "I've sent the email" }])
      .mockResolvedValueOnce([{ claimClass: 'email_sent' }]); // re-check reply without a statement
    correct.mockResolvedValue("I've emailed nothing yet, and the email was not sent.");

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: [], ports });

    expect(outcome.action).toBe('corrected');
    expect(outcome.claimMismatch).toBe(false);
  });
});

describe('buildFinalizeJudgePrompt (ENG-2459)', () => {
  const prompt = buildFinalizeJudgePrompt(CLAIMING_TEXT, ['email_sent']);

  it('tells the judge to skip negated, withheld, drafted, zero-count, quoted and historical statements', () => {
    for (const phrase of ['negated or refused', 'withheld or waiting on approval', 'a draft or proposal', 'zero-count', 'quoted or ad copy', 'already existed']) {
      expect(prompt).toContain(phrase);
    }
  });

  it('limits the judge to candidate classes and asks for a non-empty statement', () => {
    expect(prompt).toContain('Report only classes from the candidate list');
    expect(prompt).toContain('non-empty quote');
    expect(prompt).toContain('Candidate classes detected in this reply: email_sent');
  });

  it('still ends with the reply to audit', () => {
    expect(prompt.endsWith(`Reply to audit:\n${CLAIMING_TEXT}`)).toBe(true);
  });
});
