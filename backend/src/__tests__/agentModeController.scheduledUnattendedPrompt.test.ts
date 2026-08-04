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
import { agentModeController } from '../controllers/agentModeController';
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
    // ENG-803: the controller resolves the schedule's fullAutonomy opt-in into the
    // publish-authorization signal via getScheduleById. Default it to a
    // deterministic not-authorized schedule so the base suite never makes a real
    // DB call; the publish-authorization cases below override this per-test.
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

  // ── ENG-803: fabricated publish gate + silent non-execution ───────────────────
  // Wiring probe for the fix, exercising the full assembly path end-to-end
  // (controller → getScheduleById → directive → prompt).
  //
  // The reported schedule (081d18dd, "Harsha X Reply Guy") carries NO
  // fullAutonomy attribute, and a prod scan on 2026-08-04 found 0 of 897
  // schedules with it set. So the anti-fabrication rules AND the
  // "don't substitute a draft for the action you were told to take" rule must
  // ride on EVERY scheduled run regardless of the signal — gating them on
  // fullAutonomy would make them dead code for 100% of real traffic. Only the
  // publish-AUTHORIZATION block stays gated (ENG-827 owns that policy).

  it('injects the fabrication ban and the mandated-action rule on a NON-authorized schedule', async () => {
    // this is the reported schedule's exact shape — the fix must reach it.
    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue({ scheduleId: SCHEDULE_ID, fullAutonomy: false });
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
    expect(sp).toContain('report_product_issues');
    expect(sp).toContain('NEVER SUBSTITUTE A DRAFT FOR A MANDATED ACTION');
    expect(sp).toContain('twitter_manage_post');
    // …but a non-authorized schedule still gets no publish authorization.
    expect(sp).not.toContain('PUBLISH AUTHORIZATION —');
  });

  it('adds the publish-authorization block when the schedule opted into fullAutonomy', async () => {
    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue({ scheduleId: SCHEDULE_ID, fullAutonomy: true });
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    // the machine-readable owner opt-in adds authorization on top…
    expect(sp).toContain('PUBLISH AUTHORIZATION —');
    // …and the unconditional rules still ride alongside it.
    expect(sp).toContain('NEVER SUBSTITUTE A DRAFT FOR A MANDATED ACTION');
    expect(sp).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
  });

  it('withholds only the authorization block when fullAutonomy is absent (safe default)', async () => {
    // owner never opted in → schedule item lacks the flag entirely.
    (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue({ scheduleId: SCHEDULE_ID });
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt()!;
    expect(sp).not.toContain('PUBLISH AUTHORIZATION —');
    expect(sp).toContain('NEVER SUBSTITUTE A DRAFT FOR A MANDATED ACTION');
    expect(sp).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
  });

  it('degrades to NOT-authorized when the schedule lookup THROWS, keeping the unconditional rules', async () => {
    (scheduleDb.getScheduleById as jest.Mock).mockRejectedValue(new Error('DynamoDB throttled'));
    await agentModeController.generateResponse(makeReq(), makeRes());
    const sp = capturedSystemPrompt();
    // a prompt-enrichment lookup failure must never break the run, and must fail
    // closed on authorization while still shipping the truthful-reporting rules.
    expect(sp).toBeDefined();
    expect(sp!).toContain('[AUTOMATED UNATTENDED EXECUTION]');
    expect(sp!).not.toContain('PUBLISH AUTHORIZATION —');
    expect(sp!).toContain('NO FABRICATED PLATFORM OR PUBLISH GATE');
    expect(sp!).toContain('NEVER SUBSTITUTE A DRAFT FOR A MANDATED ACTION');
  });
});
