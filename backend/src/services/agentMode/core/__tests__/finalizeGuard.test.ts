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

describe('buildCorrectionSystemNote', () => {
  it('names every mismatched claim class and demands the true outcome', () => {
    const note = buildCorrectionSystemNote(['email_sent', 'post_published'] as any);
    expect(note).toContain('no successful email_sent, post_published');
    expect(note.toLowerCase()).toContain('restate the true outcome');
  });
});
