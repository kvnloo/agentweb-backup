/**
 * ENG-2459: false-alarm causes found when the guard ran in shadow mode in prod (2026-09-28..10-12).
 * 0 of the 52 `claim_mismatch` flags were a completed-action claim without a successful backing tool;
 * the causes were real tools the matchers did not know, and a judge that was never told to skip
 * negated / withheld / drafted / quoted / historical statements. Tool names below are real tools from
 * the registry (emma/tools.ts, agentModeService).
 */

import {
  runFinalizeGuard,
  claimBackedByLedger,
  claimLooselyMatchedByLedger,
  buildFinalizeJudgePrompt,
  parseFinalizeJudgeOutput,
  FINALIZE_JUDGE_MAX_COMPLETION_TOKENS,
  type ClaimClass,
  type FinalizeGuardPorts,
  type FinalizeLedgerEntry,
  type JudgedClaim,
} from '../finalizeGuard';
import { toolResultError } from '../../../../utils/toolResultError';
import { mediaGenProducedAsset } from '../toolDispatch';

const ports = { toolResultError, mediaGenProducedAsset };
const ok = (toolName: string, result: any = { success: true }): FinalizeLedgerEntry => ({ toolName, status: 'success', result });

function makeGuardPorts(judged: JudgedClaim[] | Error) {
  const judge = jest.fn(async () => {
    if (judged instanceof Error) throw judged;
    return judged;
  });
  const correct = jest.fn(async () => 'Corrected reply.');
  const errors: unknown[] = [];
  const guardPorts: FinalizeGuardPorts = {
    judgeExtractClaims: judge as any,
    requestCorrection: correct as any,
    toolResultError,
    mediaGenProducedAsset,
    recordClaimCheckError: (e) => errors.push(e),
  };
  return { guardPorts, judge, correct, errors };
}

describe('real tools that strictly back a claim class (found missing in the shadow window)', () => {
  const cases: Array<[ClaimClass, string]> = [
    ['email_sent', 'notify_session'],
    ['task_created_or_updated', 'add_gtm_work_items'],
    ['task_created_or_updated', 'update_gtm_work_item'],
    ['post_published', 'post_on_connected_account'],
  ];

  it.each(cases)('%s is strictly backed by a successful %s', (cls, tool) => {
    expect(claimBackedByLedger(cls, [ok(tool)], ports)).toBe(true);
  });

  it.each(cases)('%s is NOT backed by a failed %s', (cls, tool) => {
    expect(claimBackedByLedger(cls, [{ toolName: tool, status: 'error' }], ports)).toBe(false);
  });

  it.each(cases)('%s is NOT backed by a deferred (never executed) %s', (cls, tool) => {
    expect(claimBackedByLedger(cls, [{ toolName: tool, status: 'deferred' }], ports)).toBe(false);
  });

  it.each(cases)('%s is NOT backed by a %s whose success encodes a failure', (cls, tool) => {
    expect(claimBackedByLedger(cls, [ok(tool, { success: false, error: 'boom' })], ports)).toBe(false);
  });

  it.each(cases)('%s is backed by a successful %s whose stored result is undefined or {} (the minimised ledger shape)', (cls, tool) => {
    expect(claimBackedByLedger(cls, [{ toolName: tool, status: 'success' }], ports)).toBe(true);
    expect(claimBackedByLedger(cls, [ok(tool, {})], ports)).toBe(true);
  });

  it('a tool backing one class does not back another (notify_session is not an asset, a task or a CRM save)', () => {
    const ledger = [ok('notify_session')];
    expect(claimBackedByLedger('asset_generated', ledger, ports)).toBe(false);
    expect(claimBackedByLedger('task_created_or_updated', ledger, ports)).toBe(false);
    expect(claimBackedByLedger('crm_saved', ledger, ports)).toBe(false);
  });

  it('read-only tools still do not back a claim (no widening beyond the verified writers)', () => {
    for (const [cls, tool] of [
      ['settings_saved', 'list_knowledge_base_files'],
      ['settings_saved', 'read_knowledge_base_files'],
      ['task_created_or_updated', 'list_scheduled_chats'],
      ['crm_saved', 'search_leads'],
      ['email_sent', 'list_connected_accounts'],
    ] as Array<[ClaimClass, string]>) {
      expect(claimBackedByLedger(cls, [ok(tool)], ports)).toBe(false);
    }
  });
});

describe('tools that can succeed without doing the claimed thing are ambiguous, never strict', () => {
  const loose: Array<[ClaimClass, string]> = [
    ['email_sent', 'send_gtm_status_report'], // success even when no recipient was mailed
    ['asset_generated', 'create_html_file'], // an HTML document, not an image or video
    ['asset_generated', 'update_html_file'], // can succeed with zero operations applied
    ['asset_generated', 'create_html_from_template'],
    ['asset_generated', 'create_social_media_posts'], // an HTML page of post copy; it publishes nothing
    ['asset_generated', 'perform_data_analysis'], // charts via code execution
    ['settings_saved', 'attach_knowledge_base_files'], // persists content, not user settings
    ['settings_saved', 'update_knowledge_base_file'],
    ['settings_saved', 'create_knowledge_base'],
    ['task_created_or_updated', 'attach_knowledge_base_files'],
    ['task_created_or_updated', 'update_knowledge_base_file'],
    ['task_created_or_updated', 'create_knowledge_base'],
    ['task_created_or_updated', 'set_work_plan_status'],
    ['task_created_or_updated', 'create_work_plan'],
    ['task_created_or_updated', 'modify_work_plan'],
  ];

  it.each(loose)('%s: %s loosely matches but does not strictly back', (cls, tool) => {
    expect(claimBackedByLedger(cls, [ok(tool)], ports)).toBe(false);
    expect(claimLooselyMatchedByLedger(cls, [ok(tool)], ports)).toBe(true);
  });

  it.each(loose)('%s: a failed %s loosely matches nothing', (cls, tool) => {
    expect(claimLooselyMatchedByLedger(cls, [{ toolName: tool, status: 'error' }], ports)).toBe(false);
  });

  it('knowledge-base and work-plan READERS do not even loosely match a "task" claim', () => {
    for (const tool of ['list_knowledge_base_files', 'read_knowledge_base_files', 'search_knowledge_base', 'get_work_plan']) {
      expect(claimLooselyMatchedByLedger('task_created_or_updated', [ok(tool)], ports)).toBe(false);
    }
  });

  it('an HTML document does not strictly back an "images generated" claim (the xCures case stays a mismatch for media-gen tools)', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'asset_generated', statement: 'I generated 5 images' }]);
    const out = await runFinalizeGuard({
      finalText: 'I generated 5 images for the campaign.',
      ledger: [ok('create_html_file')],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.action).toBe('ambiguous_unmatched');
    expect(out.claimMismatch).toBe(false);
    // ...whereas a paused media-gen call with no asset still IS a confident mismatch.
    const paused = await runFinalizeGuard({
      finalText: 'I generated 5 images for the campaign.',
      ledger: [ok('generate_image', { awaitingUserConfirmation: true })],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(paused.claimMismatch).toBe(true);
  });

  it('a send_gtm_status_report-only run is ambiguous for an email claim, never a mismatch', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'sent the status report' }]);
    const out = await runFinalizeGuard({
      finalText: 'I sent the status report email to the plan owner.',
      ledger: [ok('send_gtm_status_report')],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.action).toBe('ambiguous_unmatched');
    expect(out.claimMismatch).toBe(false);
  });
});

describe('judge output handling', () => {
  const EMAIL_TEXT = 'I sent the email to the client with the report attached.';

  it('a claim whose class was not a prefilter candidate is ignored', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'post_published', statement: 'posted it' }]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.claimMismatch).toBe(false);
    expect(out.action).toBe('clean');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   \n'],
    ['non-string', 7 as any],
  ])('a claim with a %s statement is not evidence of a completed action', async (_label, statement) => {
    const { guardPorts, correct } = makeGuardPorts([{ claimClass: 'email_sent', statement } as JudgedClaim]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts });
    expect(out.claimMismatch).toBe(false);
    expect(out.action).toBe('clean');
    expect(correct).not.toHaveBeenCalled();
  });

  it('a candidate-class claim WITH a statement and no backing tool is still a mismatch (detection preserved)', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'I sent the email' }]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.action).toBe('detected_mismatch');
    expect(out.claimMismatch).toBe(true);
    expect(out.mismatchedClaimClasses).toEqual(['email_sent']);
  });

  it('shadow mode never calls the corrective turn and leaves the text untouched', async () => {
    const { guardPorts, correct } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'I sent the email' }]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(correct).not.toHaveBeenCalled();
    expect(out.finalText).toBe(EMAIL_TEXT);
  });

  it('a reply the judge clears ([]) is clean even though the lexicon matched (negated / withheld)', async () => {
    const { guardPorts } = makeGuardPorts([]);
    const out = await runFinalizeGuard({
      finalText: 'Published: 0 (withheld). The scheduled post was not sent because approval is required.',
      ledger: [],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.action).toBe('clean');
    expect(out.claimMismatch).toBe(false);
  });

  it('a notify_session email to the stated recipient backs the email claim (was a prod false alarm)', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'sent the readout via session notification email' }]);
    const out = await runFinalizeGuard({
      finalText: 'I sent the readout via session notification email to the visitor.',
      ledger: [{ toolName: 'send_email_from_sender', status: 'error' }, ok('notify_session', { success: true, sent_to: ['a@b.com'] })],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.claimMismatch).toBe(false);
    expect(out.action).toBe('clean');
  });

  it('a notify_session that failed does NOT back the email claim', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'sent the email' }]);
    const out = await runFinalizeGuard({
      finalText: 'I sent the email to the visitor.',
      ledger: [{ toolName: 'notify_session', status: 'error' }],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.claimMismatch).toBe(true);
  });

  it('the re-check after a correction also ignores statement-less claims', async () => {
    const judge = jest.fn()
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'I sent the email' }])
      .mockResolvedValueOnce([{ claimClass: 'email_sent' }]);
    const out = await runFinalizeGuard({
      finalText: EMAIL_TEXT,
      ledger: [],
      ports: { ...makeGuardPorts([]).guardPorts, judgeExtractClaims: judge as any, requestCorrection: async () => 'I sent the email after all.' },
    });
    expect(out.action).toBe('corrected');
    expect(out.claimMismatch).toBe(false);
  });
});

describe('judge output handling: edge cases', () => {
  const EMAIL_TEXT = 'I sent the email to the client with the report attached.';

  it('discarded claims are counted so a judge output-shape change is visible', async () => {
    const { guardPorts } = makeGuardPorts([
      { claimClass: 'email_sent' } as JudgedClaim,
      { claimClass: 'post_published', statement: 'posted' }, // not a candidate
      { claimClass: 'email_sent', statement: '  ' },
    ]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.discardedClaims).toBe(3);
    expect(out.claimMismatch).toBe(false);
  });

  it('discardedClaims is 0 when every claim is usable, and on the no-claims path', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'I sent the email' }]);
    const used = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [ok('send_email')], ports: guardPorts, detectOnly: true });
    expect(used.discardedClaims).toBe(0);
    const none = await runFinalizeGuard({ finalText: 'Here are three options.', ledger: [], ports: guardPorts, detectOnly: true });
    expect(none.action).toBe('no_claims');
    expect(none.discardedClaims).toBe(0);
  });

  it('a judge failure still delivers unchanged and records the error (new signature regression)', async () => {
    const { guardPorts, errors } = makeGuardPorts(new Error('judge down'));
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.action).toBe('judge_error');
    expect(out.claimMismatch).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it.each(['Email_Sent', ' email_sent ', 'EMAIL_SENT'])('tolerates class-name drift from the judge: %j', async (cls) => {
    const { guardPorts } = makeGuardPorts([{ claimClass: cls as any, statement: 'I sent the email' }]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.mismatchedClaimClasses).toEqual(['email_sent']);
    expect(out.discardedClaims).toBe(0);
  });

  it('a non-string claimClass is discarded, not thrown on', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 5 as any, statement: 'x' }, null as any]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.claimMismatch).toBe(false);
    expect(out.discardedClaims).toBe(2);
  });

  it('a duplicate-suppressed notify_session entry (success, sent_to: []) still backs the claim: the same recipients were mailed earlier', async () => {
    const { guardPorts } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'emailed the report' }]);
    const out = await runFinalizeGuard({
      finalText: 'I emailed the report to the client.',
      ledger: [ok('notify_session', { success: true, sent_to: [], duplicate_suppressed: true })],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.claimMismatch).toBe(false);
  });

  it('discardedClaims is carried on the corrected and appended_correction paths', async () => {
    const claims: JudgedClaim[] = [
      { claimClass: 'email_sent', statement: 'I sent the email' },
      { claimClass: 'email_sent' },
    ];
    const corrected = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: makeGuardPorts(claims).guardPorts });
    expect(corrected.action).toBe('corrected');
    expect(corrected.discardedClaims).toBe(1);
    const stillWrong = await runFinalizeGuard({
      finalText: EMAIL_TEXT,
      ledger: [],
      ports: { ...makeGuardPorts(claims).guardPorts, requestCorrection: async () => 'The email was sent to the client.' },
    });
    expect(stillWrong.action).toBe('appended_correction');
    expect(stillWrong.discardedClaims).toBe(1);
  });

  it('mixed claims: one backed, one unbacked -> only the unbacked class mismatches', async () => {
    const { guardPorts } = makeGuardPorts([
      { claimClass: 'email_sent', statement: 'I sent the email' },
      { claimClass: 'task_created_or_updated', statement: 'created a task' },
    ]);
    const out = await runFinalizeGuard({
      finalText: 'I sent the email and created a task for the follow-up.',
      ledger: [ok('send_email')],
      ports: guardPorts,
      detectOnly: true,
    });
    expect(out.mismatchedClaimClasses).toEqual(['task_created_or_updated']);
  });

  it('a non-candidate claim next to a real mismatch does not hide the mismatch', async () => {
    const { guardPorts } = makeGuardPorts([
      { claimClass: 'email_sent', statement: 'I sent the email' },
      { claimClass: 'post_published', statement: 'published it' },
    ]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts, detectOnly: true });
    expect(out.mismatchedClaimClasses).toEqual(['email_sent']);
    expect(out.discardedClaims).toBe(1);
  });

  it('enforce mode still corrects a real, statement-backed mismatch (customer-visible path unchanged)', async () => {
    const { guardPorts, correct } = makeGuardPorts([{ claimClass: 'email_sent', statement: 'I sent the email' }]);
    const out = await runFinalizeGuard({ finalText: EMAIL_TEXT, ledger: [], ports: guardPorts });
    expect(correct).toHaveBeenCalledTimes(1);
    expect(out.action).toBe('corrected');
    expect(out.finalText).toBe('Corrected reply.');
  });

  it('the re-check uses the corrected text\'s own candidates: a class only in the original is ignored', async () => {
    const judge = jest.fn()
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'I sent the email' }])
      .mockResolvedValueOnce([{ claimClass: 'email_sent', statement: 'I sent the email' }]); // corrected text has no email wording
    const out = await runFinalizeGuard({
      finalText: EMAIL_TEXT,
      ledger: [],
      ports: { ...makeGuardPorts([]).guardPorts, judgeExtractClaims: judge as any, requestCorrection: async () => 'The email did not go out; here is the draft.' },
    });
    expect(judge).toHaveBeenCalledTimes(1); // no candidates in the corrected text -> no second judge call
    expect(out.action).toBe('corrected');
  });
});

describe('judge prompt', () => {
  const prompt = buildFinalizeJudgePrompt('Reply body here.', ['email_sent', 'schedule_created']);

  it('carries the reply and the candidate classes', () => {
    expect(prompt).toContain('Reply body here.');
    expect(prompt).toContain('Candidate classes detected in this reply: email_sent, schedule_created');
  });

  it.each([
    ['negated or withheld actions', /did NOT happen, was withheld, blocked, skipped, failed, is pending approval, or is a draft/],
    ['zero counts', /published: 0/],
    ['plans and settings descriptions', /plan, an offer, a next step.*description of a setting or schedule/s],
    ['quoted content', /only quotes or reproduces content/],
    ['retold history', /retells from history, a CRM record, or another session/],
    ['language independence', /any language/],
    ['recaps of this run\'s own actions stay in scope', /Do not exclude a statement that reports an action this run performed/],
    ['mandatory quoted statement', /MUST include a non-empty statement/],
    ['candidate-only classes', /one of the candidate classes/],
  ])('tells the judge about %s', (_label, re) => {
    expect(prompt).toMatch(re);
  });
});

describe('parseFinalizeJudgeOutput', () => {
  it('keeps a statement that contains brackets, escaped quotes and non-ASCII text', () => {
    const raw = '[{"claimClass":"email_sent","statement":"Envié el correo [adjunto] a \\"Dana\\""}]';
    expect(parseFinalizeJudgeOutput(raw)).toEqual([{ claimClass: 'email_sent', statement: 'Envié el correo [adjunto] a "Dana"' }]);
  });
  it('tolerates a json code fence around the array', () => {
    expect(parseFinalizeJudgeOutput('```json\n[{"claimClass":"crm_saved","statement":"s"}]\n```')).toEqual([{ claimClass: 'crm_saved', statement: 's' }]);
  });
  it('keeps statements', () => {
    expect(parseFinalizeJudgeOutput('[{"claimClass":"email_sent","statement":"I sent it"}]')).toEqual([{ claimClass: 'email_sent', statement: 'I sent it' }]);
  });
  it('still throws on empty, non-array and unparseable output (judge_error path)', () => {
    expect(() => parseFinalizeJudgeOutput('')).toThrow();
    expect(() => parseFinalizeJudgeOutput('no json here')).toThrow();
    expect(() => parseFinalizeJudgeOutput('[1,')).toThrow();
  });
  it('drops elements without a string claimClass', () => {
    expect(parseFinalizeJudgeOutput('[{"statement":"x"},{"claimClass":5},{"claimClass":"crm_saved","statement":"s"}]')).toEqual([{ claimClass: 'crm_saved', statement: 's' }]);
  });
});

describe('judge output cap', () => {
  it('is sized for { claimClass, statement } objects, not the 500 tokens that fit bare classes', () => {
    expect(FINALIZE_JUDGE_MAX_COMPLETION_TOKENS).toBeGreaterThanOrEqual(800);
  });
});
