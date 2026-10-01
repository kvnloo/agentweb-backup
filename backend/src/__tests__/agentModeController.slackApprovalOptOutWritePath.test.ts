/**
 * ENG-2204 — the Slack-send-approval opt-OUT is reachable by the OWNER.
 *
 * Mirrors agentModeController.publishOptOutWritePath.test.ts exactly, for the
 * `requireSlackApproval` field this ticket adds: a schedule-level opt-out that
 * reverts one schedule to the pre-ENG-2204 behavior (never call slack_send_message
 * without a live approval) without needing a code revert. A setting NOBODY can
 * write is a dead toggle, and the override text's own unblocking instruction would
 * be pointing owners at a control that does nothing.
 *
 * NOTE THE POLARITY: `requireSlackApproval: true` means WITHHOLD the unattended
 * Slack-send override. False/absent means authorized — this is a NEW capability
 * this ticket introduces, so "absent" describing every pre-existing schedule row
 * must resolve to the NEW (authorized) behavior for the fix to actually apply to
 * them, not the reverse.
 *
 * These tests pin the owner-facing HTTP write path — POST/PUT
 * /api/agent-mode/scheduled-chats — the same contract publishOptOutWritePath.test.ts
 * pins for requirePublishApproval: read the field off req.body, coerce it strictly,
 * and — on update — leave it alone when the client omits it (same race the
 * requirePublishApproval comments there document, since both fields govern whether
 * an unattended run may act without a live approval).
 */

import { Request, Response } from 'express';

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
  getAllowedSkills: jest.fn(async () => ['*']),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesByUserId: jest.fn(),
    addRunResult: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

import { scheduleDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';
import { agentModeController } from '../controllers/agentModeController';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

const USER_ID = 'owner-1743956381327';
const SCHEDULE_ID = 'schedule-081d18dd';

const mockRes = () => ({
  json: jest.fn(),
  status: jest.fn().mockReturnThis(),
}) as unknown as Response;

const createReq = (extra: Record<string, unknown>) => ({
  user: { userId: USER_ID },
  body: {
    scheduleName: 'ThinkingAI Luma daily screening',
    startingMessage: 'Pull new registrants and post each new match to Slack.',
    scheduleFrequency: 'daily',
    ...extra,
  },
}) as unknown as Request;

const updateReq = (extra: Record<string, unknown>) => ({
  user: { userId: USER_ID },
  params: { scheduleId: SCHEDULE_ID },
  body: {
    scheduleName: 'ThinkingAI Luma daily screening',
    startingMessage: 'Pull new registrants and post each new match to Slack.',
    scheduleFrequency: 'daily',
    emailNotifications: ['owner@example.com'],
    ...extra,
  },
}) as unknown as Request;

const existingSchedule = (requireSlackApproval: boolean) => ({
  scheduleId: SCHEDULE_ID,
  userId: USER_ID,
  scheduleName: 'ThinkingAI Luma daily screening',
  startingMessage: 'Pull new registrants and post each new match to Slack.',
  frequency: 'daily',
  requireSlackApproval,
});

describe('createScheduledChat persists the owner Slack-send-approval setting (ENG-2204)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockScheduleDb.createSchedule.mockResolvedValue(undefined as never);
  });

  it('stores the opt-out when the owner asks to approve Slack sends', async () => {
    await agentModeController.createScheduledChat(
      createReq({ requireSlackApproval: true }),
      mockRes()
    );

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ requireSlackApproval: true })
    );
  });

  it('defaults to NO approval requirement when the client omits the field', async () => {
    // i.e. authorizes unattended Slack sends — this ticket's fix, applied by default.
    await agentModeController.createScheduledChat(createReq({}), mockRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ requireSlackApproval: false })
    );
  });

  it('does not withhold Slack sends on a truthy non-boolean (strict === true)', async () => {
    for (const truthy of ['true', 1, 'yes', {}]) {
      jest.clearAllMocks();
      await agentModeController.createScheduledChat(
        createReq({ requireSlackApproval: truthy }),
        mockRes()
      );
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ requireSlackApproval: false })
      );
    }
  });
});

describe('updateScheduledChat keeps the Slack-send-approval setting partial-update safe (ENG-2204)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as never);
  });

  it('records the approval requirement when the owner turns the switch on', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(false) as never);

    await agentModeController.updateScheduledChat(
      updateReq({ requireSlackApproval: true }),
      mockRes()
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ requireSlackApproval: true })
    );
  });

  it('restores unattended Slack sends when the owner turns the switch off', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(true) as never);

    await agentModeController.updateScheduledChat(
      updateReq({ requireSlackApproval: false }),
      mockRes()
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ requireSlackApproval: false })
    );
  });

  // Same race as requirePublishApproval's own test: an omitting update must write
  // NOTHING for this key, or an owner who just set the opt-out could have it
  // silently reverted by an unrelated concurrent edit (a rename, a cadence change).
  it('writes NO slack-approval key at all when an unrelated edit omits it', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(true) as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    const written = mockScheduleDb.updateSchedule.mock.calls[0][1] as Record<string, unknown>;
    expect('requireSlackApproval' in written).toBe(false);
  });

  it('writes no slack-approval key for a schedule that currently authorizes either', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(false) as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    const written = mockScheduleDb.updateSchedule.mock.calls[0][1] as Record<string, unknown>;
    expect('requireSlackApproval' in written).toBe(false);
  });

  it('leaves a legacy schedule that predates the field untouched', async () => {
    // Every schedule created before this ticket: the attribute simply is not
    // there, and an unrelated edit must not materialize it.
    const legacy = { ...existingSchedule(false) } as Record<string, unknown>;
    delete legacy.requireSlackApproval;
    mockScheduleDb.getScheduleById.mockResolvedValue(legacy as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    const written = mockScheduleDb.updateSchedule.mock.calls[0][1] as Record<string, unknown>;
    expect('requireSlackApproval' in written).toBe(false);
  });
});
