/**
 * ENG-803 — the unattended-publishing opt-in is reachable by the OWNER.
 *
 * Companion to agentModeController.unattemptedPublishGate.test.ts, which pins the
 * opposite guarantee: the model cannot set this field (it is absent from the
 * manage_scheduled_chat MCP allowlist). Both halves matter. A consent signal only
 * the model can write is the ENG-803 defect inverted; a consent signal NOBODY can
 * write is a dead toggle, and the prompt's unblocking instruction ("turn on
 * 'Publish without approval'") would send owners to a control that does nothing.
 *
 * These tests pin the owner-facing HTTP write path — POST/PUT
 * /api/agent-mode/scheduled-chats — that the Customer Portal's "Publish without
 * approval" switch calls. The switch itself lives in the separate
 * agentweb-customer-portal repo
 * (src/components/agent-mode/schedule/ScheduleFormPanel.tsx); it submits the whole
 * form object, so the contract that actually needs guarding is this one: the
 * handlers must read the field off req.body, coerce it strictly, and — on update —
 * leave it alone when the client omits it.
 */

import { Request, Response } from 'express';

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
  getAllowedSkills: jest.fn(async () => ['*']),
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

/** Minimum valid body for the create handler, plus whatever the test is pinning. */
const createReq = (extra: Record<string, unknown>) => ({
  user: { userId: USER_ID },
  body: {
    scheduleName: 'Harsha X Reply Guy — Mentions',
    startingMessage: 'Source recent mentions and POST replies directly.',
    scheduleFrequency: 'daily',
    ...extra,
  },
}) as unknown as Request;

const updateReq = (extra: Record<string, unknown>) => ({
  user: { userId: USER_ID },
  params: { scheduleId: SCHEDULE_ID },
  body: {
    scheduleName: 'Harsha X Reply Guy — Mentions',
    startingMessage: 'Source recent mentions and POST replies directly.',
    scheduleFrequency: 'daily',
    emailNotifications: ['harsha@agentweb.pro'],
    ...extra,
  },
}) as unknown as Request;

/** The stored schedule the update handler merges onto. */
const existingSchedule = (unattendedPublishAuthorized: boolean) => ({
  scheduleId: SCHEDULE_ID,
  userId: USER_ID,
  scheduleName: 'Harsha X Reply Guy — Mentions',
  startingMessage: 'Source recent mentions and POST replies directly.',
  frequency: 'daily',
  unattendedPublishAuthorized,
});

describe('createScheduledChat persists the owner publishing opt-in (ENG-803)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockScheduleDb.createSchedule.mockResolvedValue(undefined as never);
  });

  it('stores the opt-in when the owner turns the switch on', async () => {
    await agentModeController.createScheduledChat(
      createReq({ unattendedPublishAuthorized: true }),
      mockRes()
    );

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ unattendedPublishAuthorized: true })
    );
  });

  it('defaults to NOT authorized when the client omits the field', async () => {
    await agentModeController.createScheduledChat(createReq({}), mockRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ unattendedPublishAuthorized: false })
    );
  });

  it('does not grant publishing on a truthy non-boolean (strict === true)', async () => {
    // A form/query serialisation that stringifies booleans must not be read as consent.
    for (const truthy of ['true', 1, 'yes', {}]) {
      jest.clearAllMocks();
      await agentModeController.createScheduledChat(
        createReq({ unattendedPublishAuthorized: truthy }),
        mockRes()
      );
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ unattendedPublishAuthorized: false })
      );
    }
  });
});

describe('updateScheduledChat keeps the opt-in partial-update safe (ENG-803)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as never);
  });

  it('grants publishing when the owner turns the switch on', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(false) as never);

    await agentModeController.updateScheduledChat(
      updateReq({ unattendedPublishAuthorized: true }),
      mockRes()
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ unattendedPublishAuthorized: true })
    );
  });

  it('revokes publishing when the owner turns the switch off', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(true) as never);

    await agentModeController.updateScheduledChat(
      updateReq({ unattendedPublishAuthorized: false }),
      mockRes()
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ unattendedPublishAuthorized: false })
    );
  });

  it('preserves an existing grant when an unrelated edit omits the field', async () => {
    // e.g. renaming the schedule must not silently revoke publishing.
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(true) as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ unattendedPublishAuthorized: true })
    );
  });

  it('does not invent a grant when an unrelated edit omits the field', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(false) as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ unattendedPublishAuthorized: false })
    );
  });

  it('leaves a legacy schedule that predates the field unauthorized', async () => {
    // Every schedule created before this PR: the attribute simply is not there.
    const legacy = { ...existingSchedule(false) } as Record<string, unknown>;
    delete legacy.unattendedPublishAuthorized;
    mockScheduleDb.getScheduleById.mockResolvedValue(legacy as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ unattendedPublishAuthorized: false })
    );
  });
});
