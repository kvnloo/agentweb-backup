import { Request, Response } from 'express';

// Mock dependencies
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    updateSchedule: jest.fn(),
    createSchedule: jest.fn(),
  },
}));

// Import after mocks
import { scheduleDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';
import { agentModeController } from '../controllers/agentModeController';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;

describe('AgentModeController - Custom Run Time for Scheduled Chats', () => {
  const mockUserId = 'test-user-123';
  const mockScheduleId = 'test-schedule-123';

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
  });

  describe('createScheduledChat with custom nextRunTime', () => {
    it('should create schedule with custom nextRunTime when provided', async () => {
      const customRunTime = '2026-02-15T14:30:00.000Z';

      mockScheduleDb.createSchedule.mockResolvedValue(undefined);

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          scheduleName: 'Test Schedule',
          startingMessage: 'Hello',
          scheduleFrequency: 'daily',
          nextRunTime: customRunTime,
          emailNotifications: ['test@example.com'],
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          nextRunTime: customRunTime,
        })
      );

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Scheduled chat created successfully',
        })
      );
    });

    it('should create schedule with calculated time when nextRunTime not provided', async () => {
      mockScheduleDb.createSchedule.mockResolvedValue(undefined);

      const beforeTime = new Date();

      const mockReq = {
        user: { userId: mockUserId },
        body: {
          scheduleName: 'Test Schedule',
          startingMessage: 'Hello',
          scheduleFrequency: 'daily',
          emailNotifications: ['test@example.com'],
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.createScheduledChat(mockReq, mockRes);

      const createCall = mockScheduleDb.createSchedule.mock.calls[0][0];
      const nextRunTime = new Date(createCall.nextRunTime);

      // Should be calculated based on current time + 1 day
      expect(nextRunTime.getTime()).toBeGreaterThan(beforeTime.getTime());
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          nextRunTime: expect.any(String),
        })
      );
    });
  });

  describe('updateScheduledChat with custom nextRunTime', () => {
    const existingSchedule = {
      scheduleId: mockScheduleId,
      userId: mockUserId,
      frequency: 'daily',
      nextRunTime: '2026-01-20T09:00:00.000Z',
      scheduleName: 'Original',
      startingMessage: 'Hello',
      emailNotifications: ['test@example.com'],
    };

    beforeEach(() => {
      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);
    });

    it('should update nextRunTime when provided', async () => {
      const newRunTime = '2026-02-20T14:30:00.000Z';

      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated',
          startingMessage: 'Hello',
          scheduleFrequency: 'daily',
          nextRunTime: newRunTime,
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
        mockScheduleId,
        expect.objectContaining({
          nextRunTime: newRunTime,
        })
      );

      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Scheduled chat updated successfully',
        nextRunTime: newRunTime,
      });
    });

    it('should preserve existing nextRunTime when not provided', async () => {
      const mockReq = {
        user: { userId: mockUserId },
        params: { scheduleId: mockScheduleId },
        body: {
          scheduleName: 'Updated',
          startingMessage: 'Hello',
          scheduleFrequency: 'daily',
        },
      } as unknown as Request;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await agentModeController.updateScheduledChat(mockReq, mockRes);

      // The update should NOT include nextRunTime (so it stays unchanged in DB)
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0][1];
      expect(updateCall).not.toHaveProperty('nextRunTime');

      // Response should still return the existing nextRunTime
      expect(mockRes.json).toHaveBeenCalledWith({
        message: 'Scheduled chat updated successfully',
        nextRunTime: existingSchedule.nextRunTime,
      });
    });
  });
});
