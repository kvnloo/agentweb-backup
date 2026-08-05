/**
 * End-to-end integration test for the scheduled-session system-prompt assembly
 * inside generateSessionResponse (via the generateResponse controller).
 *
 * This is the regression test for the actual bug scenario behind PR #1941
 * (session b56a2eac — Daily Event Lead Engagement Review):
 *
 *   Agent extracts guest lists for 3 events → hits a LinkedIn blocker on
 *   Event 1 → skips Events 2 & 3.
 *
 * The unit tests in agentModeService.scheduledSessionContext.test.ts cover the
 * getUnattendedExecutionDirective() function in isolation. This file instead
 * exercises the REAL assembly path end-to-end: it drives generateResponse with
 * a scheduled session (pageIdentifier carrying a scheduleId), captures the
 * system message that generateSessionResponse persists via addMessageToSession,
 * and asserts the assembled systemPrompt actually contains the full
 * [AUTOMATED UNATTENDED EXECUTION] block — including the per-entity completion
 * loop and blocker-isolation guidance that the bug required — alongside the
 * [Schedule Context] block (controller lines 1909–1915).
 */

import { Request, Response } from 'express';
import { agentModeController, generateSessionResponse } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { userDb, scheduleDb } from '../services/db';

// ── Mocks (mirror agentModeController.errorHandling.test.ts) ──────────────────
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionContextLimitReported: jest.fn().mockResolvedValue(undefined),
    createOrReuseInteractiveShare: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
  updateTaskExecutionStatus: jest.fn(),
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'p', notionUrl: 'https://notion.so/p' }),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2'),
    generateSessionTitle: jest.fn().mockResolvedValue('Test Title'),
    // Distinctive base prompt so we can assert the directive is APPENDED to it.
    getMarketingSystemPrompt: jest.fn().mockResolvedValue('BASE_MARKETING_SYSTEM_PROMPT'),
    generateDiagnosticMessage: jest.fn().mockResolvedValue(null),
  },
  AgentModeService: jest.fn(),
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true, warning: false, used: 0, allowance: null,
    bonus: 0, effectiveAllowance: null, percentUsed: 0, month: '2026-06',
  }),
}));

jest.mock('../utils/sseProgress', () => ({
  progressStore: { delete: jest.fn() },
  emitProgress: jest.fn(),
  hasActiveProgress: jest.fn().mockReturnValue(false),
  requestCancel: jest.fn(),
  clearCancel: jest.fn(),
  isCancelled: jest.fn().mockReturnValue(false),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

// Pull the system message that generateSessionResponse persisted on the first turn.
function capturedSystemPrompt(): string | undefined {
  const call = mockChatbotDb.addMessageToSession.mock.calls.find(
    (c) => (c[1] as any)?.role === 'system'
  );
  return call ? (call[1] as any).content as string : undefined;
}

const USER_ID = 'user-led-eng';
const SESSION_ID = 'sess-led-eng';
const SCHEDULE_ID = 'b56a2eac-a534-48ca-8320-4571f700e2df';

// A scheduled lead-engagement session, exactly like the failing run.
const scheduledSession = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  title: 'Scheduled: Daily Event Lead Engagement Review',
  messages: [], // empty → isFirstMessage true → system message gets assembled
  createdAt: '2026-06-15T02:00:00Z',
  updatedAt: '2026-06-15T02:00:00Z',
  portalType: 'agent' as const,
  sessionType: 'scheduled' as const,
  pageIdentifier: `Scheduled: Daily Event Lead Engagement Review|scheduleId:${SCHEDULE_ID}`,
  llmModel: 'anthropic.claude-opus-4-8',
};

function makeReq(overrides: any = {}): Request {
  return {
    user: { userId: USER_ID, email: 'lead@example.com' },
    body: {
      sessionId: SESSION_ID,
      userMessage:
        'For each of the 3 Luma events, extract the guest list, run LinkedIn ' +
        'research, ICP-filter, and check pending approvals.',
      llmModel: 'anthropic.claude-opus-4-8',
      attachments: [],
      ...overrides,
    },
    method: 'POST',
    path: '/api/agent-mode/generate',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn(),
  } as unknown as Request;
}

function makeRes(): Response {
  return { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response;
}

describe('Scheduled lead-engagement run — assembled system prompt (E2E)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.getChatSession.mockResolvedValue(scheduledSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(scheduledSession as any);
    // Default owner-admin lookup to a deterministic non-admin so the base suite
    // never makes a real DB call; admin-gating cases below override this per-test.
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: USER_ID, isAdmin: false } as any);
    // ENG-827: publish authorization is derived from the schedule's fullAutonomy
    // flag. Default the lookup to a non-autonomous schedule (draft-and-notify);
    // publish-authorized cases below override this per-test.
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({ scheduleId: SCHEDULE_ID, fullAutonomy: false } as any);
    // Worker returns a normal success so generateResponse completes without error.
    mockWorker.runInWorker.mockResolvedValue({
      content: 'Report delivered.',
      toolCalls: [],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    });
  });

  it('persists a system message on the first turn of a scheduled session', async () => {
    await agentModeController.generateResponse(makeReq(), makeRes());
    expect(capturedSystemPrompt()).toBeDefined();
  });

  it('appends the directive to the marketing base prompt (not a replacement)', async () => {
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('BASE_MARKETING_SYSTEM_PROMPT');
    // directive comes AFTER the base prompt
    expect(sp.indexOf('BASE_MARKETING_SYSTEM_PROMPT'))
      .toBeLessThan(sp.indexOf('[AUTOMATED UNATTENDED EXECUTION]'));
  });

  it('includes the full [AUTOMATED UNATTENDED EXECUTION] block end-to-end', async () => {
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).toContain('PER-ENTITY COMPLETION LOOP');
    expect(sp).toContain('BLOCKER ISOLATION');
    expect(sp).toContain('COMPLETION GATE');
    expect(sp).toContain('SURFACE GAPS AS ACTIONABLE ITEMS');
  });

  it('carries the per-entity / blocker-isolation guidance that the bug required', async () => {
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    // "complete every step for every entity, not just the first"
    expect(sp).toContain('not just the first');
    expect(sp).toMatch(/every (entity|item)/i);
    // a single-entity blocker (e.g. LinkedIn not connected) must NOT stop the rest
    expect(sp).toContain('does NOT block the others');
    expect(sp).toContain('CONTINUE processing the remaining');
    // only a global unrecoverable error halts the run
    expect(sp).toContain('GLOBAL error');
  });

  it('includes the [Schedule Context] block with the scheduleId (covers scheduleIdMatch branch)', async () => {
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('[Schedule Context]');
    expect(sp).toContain(`scheduleId: ${SCHEDULE_ID}`);
  });

  it('orders Schedule Context before the unattended directive', async () => {
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp.indexOf('[Schedule Context]'))
      .toBeLessThan(sp.indexOf('[AUTOMATED UNATTENDED EXECUTION]'));
  });

  it('still injects the directive when sessionType is scheduled but pageIdentifier has no scheduleId', async () => {
    // sessionType scheduled but pageIdentifier missing the scheduleId token:
    // scheduleIdMatch is null → no [Schedule Context], but directive still injected.
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...scheduledSession,
      pageIdentifier: 'Scheduled: Daily Event Lead Engagement Review',
    } as any);

    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).not.toContain('[Schedule Context]');
    expect(sp).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).toContain('PER-ENTITY COMPLETION LOOP');
    // ENG-827: without a scheduleId there is nothing to look up, so the run must
    // skip getScheduleById entirely and fall back to the safe withhold default —
    // guarding against a regression in the `if (scheduleIdMatch)` guard (a default
    // to true, or a lookup on a bad id, would flip publish authorization on).
    expect(scheduleDb.getScheduleById).not.toHaveBeenCalled();
    expect(sp).toContain('NOT pre-authorized to publish');
  });

  it('does NOT inject the unattended directive for a regular (non-scheduled) session', async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...scheduledSession,
      sessionType: 'regular',
      pageIdentifier: 'agent-mode',
    } as any);

    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('BASE_MARKETING_SYSTEM_PROMPT');
    expect(sp).not.toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).not.toContain('PER-ENTITY COMPLETION LOOP');
    expect(sp).not.toContain('[Schedule Context]');
  });

  it('does NOT inject the directive when a scheduled session has no pageIdentifier', async () => {
    // controller guard requires both sessionType === 'scheduled' AND pageIdentifier.
    mockChatbotDb.getChatSession.mockResolvedValue({
      ...scheduledSession,
      pageIdentifier: undefined,
    } as any);

    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).not.toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).not.toContain('[Schedule Context]');
  });

  // ── Admin-gating of the identity-resolution slice (ENG-500 / Greptile P2) ─────
  // The controller resolves the schedule owner's admin status via userDb and
  // passes it to getUnattendedExecutionDirective. Cover all three branches of
  // that lookup end-to-end (admin, non-admin, lookup failure) so a regression in
  // the wiring can't silently drop the identity guidance from admin runs or leak
  // it into non-admin ones.
  it('injects the identity-resolution slice for an ADMIN schedule owner', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: USER_ID, isAdmin: true } as any);
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).toContain('IDENTITY RESOLUTION');
    expect(sp).toContain('list_all_clients');
  });

  it('OMITS the identity-resolution slice for a NON-ADMIN owner (general directive still present)', async () => {
    jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: USER_ID, isAdmin: false } as any);
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).toContain('PER-ENTITY COMPLETION LOOP');
    expect(sp).not.toContain('IDENTITY RESOLUTION');
    expect(sp).not.toContain('list_all_clients');
  });

  it('degrades to non-admin (omits the slice) and still assembles the prompt when the owner lookup THROWS', async () => {
    jest.spyOn(userDb, 'getUserById').mockRejectedValue(new Error('DynamoDB throttled'));
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt();
    // safe fallback: prompt still assembled, general directive present, admin-only slice omitted, no throw
    expect(sp).toBeDefined();
    expect(sp!).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp!).not.toContain('IDENTITY RESOLUTION');
  });

  // ── Publish authorization signal (ENG-827) ───────────────────────────────────
  // The controller resolves the schedule's fullAutonomy flag into the publish
  // authorization block. Cover the authorize / withhold / lookup-failure branches
  // end-to-end so a regression in the wiring can't silently drop the signal.
  it('AUTHORIZES publishing when the schedule is fullAutonomy (pre-authorized)', async () => {
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({ scheduleId: SCHEDULE_ID, fullAutonomy: true } as any);
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('PUBLISH AUTHORIZATION');
    expect(sp).toContain('PRE-AUTHORIZED to publish');
    expect(sp).toContain('post_on_connected_account');
    expect(sp).not.toContain('NOT pre-authorized to publish');
  });

  it('WITHHOLDS publishing (draft & notify) when the schedule is not fullAutonomy', async () => {
    // beforeEach already defaults fullAutonomy:false
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('PUBLISH AUTHORIZATION');
    expect(sp).toContain('NOT pre-authorized to publish');
    expect(sp).not.toContain('PRE-AUTHORIZED to publish');
  });

  // Greptile P1: runScheduledChat fixes the required-function list once from its
  // own schedule snapshot, while this prompt re-reads the schedule on every
  // verification attempt. If a throttled read emitted the prohibition, the prompt
  // would forbid a publish tool the checker still requires — the exact nudge-loop
  // contradiction. An unreadable schedule must emit NO publish block instead.
  it('emits NO publish block (not a prohibition) when the schedule lookup THROWS', async () => {
    jest.spyOn(scheduleDb, 'getScheduleById').mockRejectedValue(new Error('DynamoDB throttled'));
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    // the run still proceeds with the rest of the unattended directive
    expect(sp).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp).not.toContain('PUBLISH AUTHORIZATION');
    expect(sp).not.toContain('NOT pre-authorized to publish');
    expect(sp).not.toContain('PRE-AUTHORIZED to publish');
  });

  // ── The actual production shape (ENG-827) ────────────────────────────────────
  // Every reported session ran on a schedule with requiredFunctionCalls naming
  // post_on_connected_account, fullAutonomy OFF, and a prompt that explicitly
  // waives approval. The toggle is surfaced as governing mid-run questions, so no
  // owner automating a daily post ticks it — authorization has to come from the
  // owner's own configuration, or the fix never fires for a single real schedule.
  it('AUTHORIZES publishing on the reported shape (required tool + prompt waiver), fullAutonomy OFF', async () => {
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      fullAutonomy: false,
      requiredFunctionCalls: ['post_on_connected_account'],
      startingMessage: 'Post the FULL text automatically. Do not ask for approval.',
    } as any);
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('PRE-AUTHORIZED to publish');
    expect(sp).not.toContain('NOT pre-authorized to publish');
    // the directive must name the exact tool the owner designated
    expect(sp).toContain('they explicitly designated post_on_connected_account');
  });

  // ── Single-source authorization (Greptile P1) ────────────────────────────────
  // A scheduled run threads the authorization it was ADMITTED under down from
  // runScheduledChat, which resolved it once from the same schedule snapshot it
  // used to build `requiredFunctions`. When that override is supplied the prompt
  // MUST use it verbatim and never re-read the schedule — otherwise the prompt and
  // the required-function checker are two independent reads that can disagree.
  const callWithOverride = (auth: { authorized: boolean; tools: string[] }) =>
    generateSessionResponse(
      SESSION_ID,
      'Draft and publish the daily post.',
      USER_ID,
      'anthropic.claude-opus-4-8',
      [],
      undefined, undefined, undefined, undefined, undefined, undefined,
      auth
    );

  it('uses the caller-supplied AUTHORIZED decision and never re-reads the schedule', async () => {
    // DB disagrees (and would say withheld) — the override must win outright.
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({ scheduleId: SCHEDULE_ID, fullAutonomy: false } as any);
    await callWithOverride({ authorized: true, tools: ['post_on_connected_account'] });
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('PRE-AUTHORIZED to publish');
    expect(sp).not.toContain('NOT pre-authorized to publish');
    expect(sp).toContain('they explicitly designated post_on_connected_account');
    expect(scheduleDb.getScheduleById).not.toHaveBeenCalled();
  });

  it('uses the caller-supplied WITHHELD decision even when the schedule would authorize', async () => {
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
    } as any);
    await callWithOverride({ authorized: false, tools: [] });
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('NOT pre-authorized to publish');
    expect(sp).not.toContain('PRE-AUTHORIZED to publish');
    expect(scheduleDb.getScheduleById).not.toHaveBeenCalled();
  });

  it('is immune to a schedule-lookup failure once the decision is threaded in', async () => {
    // The exact P1 scenario: a throttled read can no longer flip the prompt away
    // from the decision the required-function checker is already enforcing.
    jest.spyOn(scheduleDb, 'getScheduleById').mockRejectedValue(new Error('DynamoDB throttled'));
    await callWithOverride({ authorized: true, tools: ['post_on_connected_account'] });
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('PRE-AUTHORIZED to publish');
    expect(sp).not.toContain('NOT pre-authorized to publish');
  });

  // Greptile P1 regression: the Required Functions picker is a VERIFICATION control
  // with no approval-waiver language in its UI. A schedule whose owner ticked a
  // publish tool but never waived approval — the active "LUCAS — LinkedIn Thought
  // Leadership" shape, and 5 of the 8 production publish-requiring schedules — must
  // keep drafting, not silently start publishing to a live account.
  it('WITHHOLDS when a publish tool is required but the prompt never waives approval', async () => {
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      fullAutonomy: false,
      requiredFunctionCalls: ['generate_image', 'post_on_connected_account'],
      startingMessage:
        'Generate an image automatically and draft a LinkedIn thought-leadership post.',
    } as any);
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('NOT pre-authorized to publish');
    expect(sp).not.toContain('PRE-AUTHORIZED to publish');
  });

  it('still WITHHOLDS when the required functions contain no publishing tool', async () => {
    jest.spyOn(scheduleDb, 'getScheduleById').mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      fullAutonomy: false,
      requiredFunctionCalls: ['you_search_web', 'create_social_media_posts', 'send_email'],
    } as any);
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('NOT pre-authorized to publish');
    expect(sp).not.toContain('PRE-AUTHORIZED to publish');
  });
});
