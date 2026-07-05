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
      .mockResolvedValueOnce([{ claimClass: 'email_sent' }]); // initial check
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

  it('corrective turn does NOT resolve → visible correction appended + claimMismatch (failure path)', async () => {
    const { ports, judge, correct } = makePorts();
    const stillLying = 'The email was sent earlier today as requested.';
    judge
      .mockResolvedValueOnce([{ claimClass: 'email_sent' }]) // initial check
      .mockResolvedValueOnce([{ claimClass: 'email_sent' }]); // re-check on corrected text
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
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'asset_generated' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'asset_generated' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent' }]);

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
      .mockResolvedValueOnce([{ claimClass: 'email_sent' }])
      .mockRejectedValueOnce(new Error('judge flake on re-check'));
    correct.mockResolvedValue(stillLying);

    const outcome = await runFinalizeGuard({ finalText: CLAIMING_TEXT, ledger: emptyLedger, ports });

    expect(outcome.action).toBe('appended_correction');
    expect(outcome.claimMismatch).toBe(true);
    expect(claimCheckErrors).toHaveLength(1);
  });

  it('settings_saved claim with NO successful memory/config tool in ledger → corrective turn (ENG-143 gap)', async () => {
    const { ports, judge, correct } = makePorts();
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'settings_saved' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated' }]);
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
    judge.mockResolvedValueOnce([{ claimClass: 'task_created_or_updated' }]);
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
      { claimClass: 'email_sent' },
      { claimClass: 'task_created_or_updated' },
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
    judge.mockResolvedValueOnce([{ claimClass: 'email_sent' }]);
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
