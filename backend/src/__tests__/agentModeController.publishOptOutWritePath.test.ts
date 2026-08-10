/**
 * ENG-803 — the publish-approval opt-OUT is reachable by the OWNER.
 *
 * Companion to schedulePublishApproval.mcpGuard.test.ts, which pins the opposite
 * guarantee: the model cannot set this field (it is absent from the
 * manage_scheduled_chat MCP allowlist). Both halves matter. A setting only the
 * model can write lets Emma decide her own publishing permission; a setting
 * NOBODY can write is a dead toggle, and the prompt's unblocking instruction
 * ("turn OFF 'Require approval before publishing'") would send owners to a
 * control that does nothing.
 *
 * NOTE THE POLARITY: `requirePublishApproval: true` means HOLD at the publish
 * step. False/absent means publish, which is what scheduled runs have always
 * done — so an omitted field must resolve to false, never to true, or existing
 * schedules would stop publishing.
 *
 * These tests pin the owner-facing HTTP write path — POST/PUT
 * /api/agent-mode/scheduled-chats — that the Customer Portal's "Require approval
 * before publishing" switch calls. The switch itself lives in the separate
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
const existingSchedule = (requirePublishApproval: boolean) => ({
  scheduleId: SCHEDULE_ID,
  userId: USER_ID,
  scheduleName: 'Harsha X Reply Guy — Mentions',
  startingMessage: 'Source recent mentions and POST replies directly.',
  frequency: 'daily',
  requirePublishApproval,
});

describe('createScheduledChat persists the owner publish-approval setting (ENG-803)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockScheduleDb.createSchedule.mockResolvedValue(undefined as never);
  });

  it('stores the opt-out when the owner asks to approve publishing', async () => {
    await agentModeController.createScheduledChat(
      createReq({ requirePublishApproval: true }),
      mockRes()
    );

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ requirePublishApproval: true })
    );
  });

  it('defaults to NO approval requirement when the client omits the field', async () => {
    // i.e. keeps publishing — the behaviour every existing schedule has today.
    await agentModeController.createScheduledChat(createReq({}), mockRes());

    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ requirePublishApproval: false })
    );
  });

  it('does not halt publishing on a truthy non-boolean (strict === true)', async () => {
    // A serialisation that stringifies booleans must not silently stop a working schedule.
    for (const truthy of ['true', 1, 'yes', {}]) {
      jest.clearAllMocks();
      await agentModeController.createScheduledChat(
        createReq({ requirePublishApproval: truthy }),
        mockRes()
      );
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ requirePublishApproval: false })
      );
    }
  });
});

describe('updateScheduledChat keeps the publish-approval setting partial-update safe (ENG-803)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockScheduleDb.updateSchedule.mockResolvedValue(undefined as never);
  });

  it('records the approval requirement when the owner turns the switch on', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(false) as never);

    await agentModeController.updateScheduledChat(
      updateReq({ requirePublishApproval: true }),
      mockRes()
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ requirePublishApproval: true })
    );
  });

  it('restores publishing when the owner turns the switch off', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(true) as never);

    await agentModeController.updateScheduledChat(
      updateReq({ requirePublishApproval: false }),
      mockRes()
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ requirePublishApproval: false })
    );
  });

  // ENG-827 (Greptile): an omitting update must write NOTHING for this key.
  //
  // It previously copied the value forward from `existingSchedule`, which reads as
  // "preserve" but is a read-modify-write. This field decides whether an unattended
  // run may post publicly, so the race is not academic: an owner who switches the
  // hold ON between this handler's read and its write has it silently reverted to OFF
  // by an unrelated edit — a rename re-enabling publishing they had just stopped.
  // `updateSchedule` builds a PARTIAL SET expression, so omitting the key is what
  // actually preserves the stored value, race and all.
  it('writes NO publish key at all when an unrelated edit omits it', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(true) as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    const written = mockScheduleDb.updateSchedule.mock.calls[0][1] as Record<string, unknown>;
    expect('requirePublishApproval' in written).toBe(false);
  });

  it('writes no publish key for a schedule that currently publishes either', async () => {
    // Same rule in the other direction: absence of the key is the answer regardless
    // of the stored value, so no read is ever echoed back.
    mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule(false) as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    const written = mockScheduleDb.updateSchedule.mock.calls[0][1] as Record<string, unknown>;
    expect('requirePublishApproval' in written).toBe(false);
  });

  it('leaves a legacy schedule that predates the field untouched', async () => {
    // Every schedule created before ENG-803: the attribute simply is not there, and
    // an unrelated edit must not materialize it.
    const legacy = { ...existingSchedule(false) } as Record<string, unknown>;
    delete legacy.requirePublishApproval;
    mockScheduleDb.getScheduleById.mockResolvedValue(legacy as never);

    await agentModeController.updateScheduledChat(updateReq({}), mockRes());

    const written = mockScheduleDb.updateSchedule.mock.calls[0][1] as Record<string, unknown>;
    expect('requirePublishApproval' in written).toBe(false);
  });
});
