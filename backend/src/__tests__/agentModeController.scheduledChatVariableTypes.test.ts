import { Request, Response } from 'express';

// Mock all dependencies before importing the controller
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => ['*']),
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
    // ENG-892: model resolution is orthogonal to what this suite asserts —
    // pass the requested id through unchanged.
    resolveGenerationModel: jest.fn((model: string) => ({ model, fellBack: false, requestedModel: model })),
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateMarketingResponse: jest.fn(),
    installSkills: jest.fn().mockResolvedValue({ success: true, installedSkills: [] }),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set([
      'install_skills', 'search_web', 'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
    ])),
    getAdminToolNames: jest.fn().mockReturnValue([
      'list_predefined_work_plans', 'manage_predefined_work_plan',
      'list_skills', 'manage_skill', 'get_chat_history',
    ]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
    releaseSessionClients: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    createSchedule: jest.fn(),
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    getScheduledChatByVariableAccessTokenHash: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue('acquired'),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    updateSchedule: jest.fn(),
    getSchedulesByUserId: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-run-id-123'),
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true,
    warning: false,
    used: 100000,
    allowance: 1000000,
    bonus: 0,
    effectiveAllowance: 1000000,
    percentUsed: 10,
    month: '2026-04',
  })),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb, userDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { uploadFileToS3 } from '../utils/s3Utils';
import { agentModeController, runVerifiedChat, runScheduledChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockUploadFileToS3 = uploadFileToS3 as jest.MockedFunction<typeof uploadFileToS3>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('Scheduled Chat Variable Types', () => {
  const mockUserId = 'test-user-456';

  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2');
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2');
  });

  describe('createScheduledChat - variable type preservation', () => {
    it('should preserve variable type field when creating a schedule with typed variables', async () => {
      const req = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          scheduleName: 'Test Variable Types',
          startingMessage: 'Hello {{name}}, here is {{doc}}',
          variables: [
            { name: 'name', description: 'User name', type: 'text' },
            { name: 'doc', description: 'Document', type: 'file' },
          ],
          scheduleFrequency: 'daily',
          nextRunTime: '2026-03-01T10:00:00Z',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
        },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.createSchedule.mockResolvedValue({
        scheduleId: 'new-schedule-id',
      } as any);

      await agentModeController.createScheduledChat(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const createCall = mockScheduleDb.createSchedule.mock.calls[0][0];
      expect(createCall.variables).toEqual([
        { name: 'name', description: 'User name', type: 'text' },
        { name: 'doc', description: 'Document', type: 'file' },
      ]);
    });

    it('should preserve long_text type through variable sync', async () => {
      const req = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          scheduleName: 'Long Text Schedule',
          startingMessage: 'Process this: {{content}}',
          variables: [
            { name: 'content', description: 'Main content', type: 'long_text' },
          ],
          scheduleFrequency: 'daily',
          nextRunTime: '2026-03-01T10:00:00Z',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
        },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.createSchedule.mockResolvedValue({ scheduleId: 'new-id' } as any);

      await agentModeController.createScheduledChat(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const createCall = mockScheduleDb.createSchedule.mock.calls[0][0];
      expect(createCall.variables).toEqual([
        { name: 'content', description: 'Main content', type: 'long_text' },
      ]);
    });

    it('should reject invalid variable type values', async () => {
      const req = {
        user: { userId: mockUserId, email: 'test@example.com' },
        body: {
          scheduleName: 'Invalid Type Schedule',
          startingMessage: 'Hello {{name}}',
          variables: [
            { name: 'name', description: 'Name', type: 'invalid_type' },
          ],
          scheduleFrequency: 'daily',
          nextRunTime: '2026-03-01T10:00:00Z',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
        },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.createSchedule.mockResolvedValue({ scheduleId: 'new-id' } as any);

      await agentModeController.createScheduledChat(req, res);

      // Invalid type should be stripped, variable saved without type
      expect(res.status).toHaveBeenCalledWith(201);
      const createCall = mockScheduleDb.createSchedule.mock.calls[0][0] as any;
      expect(createCall.variables[0].type).toBeUndefined();
    });
  });

  describe('getScheduledChatVariablesByAccessToken - returns type field', () => {
    it('should return variable type in the response', async () => {
      const req = {
        params: { accessToken: 'valid-token-abc' },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue({
        scheduleId: 'sched-1',
        scheduleName: 'Typed Variables',
        userId: mockUserId,
        variables: [
          { name: 'report', description: 'Report file', type: 'file' },
          { name: 'notes', description: 'Extra notes', type: 'long_text' },
          { name: 'title', description: 'Title' },
        ],
        variableRequestStatus: 'pending',
        variableRequestAccessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      await agentModeController.getScheduledChatVariablesByAccessToken(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: [
            { name: 'report', description: 'Report file', type: 'file' },
            { name: 'notes', description: 'Extra notes', type: 'long_text' },
            { name: 'title', description: 'Title' },
          ],
        })
      );
    });
  });

  describe('uploadScheduledChatVariableFile - public file upload', () => {
    const validSchedule = {
      scheduleId: 'sched-1',
      userId: mockUserId,
      variables: [{ name: 'doc', type: 'file' }],
      variableRequestAccessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    };

    it('should upload file and return metadata for valid access token', async () => {
      const req = {
        params: { accessToken: 'valid-upload-token' },
        file: {
          buffer: Buffer.from('test file content'),
          originalname: 'report.pdf',
          size: 17,
          mimetype: 'application/pdf',
        },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue(validSchedule);
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.amazonaws.com/bucket/report.pdf',
        key: 'users/test/report.pdf',
      });

      await agentModeController.uploadScheduledChatVariableFile(req, res);

      expect(res.json).toHaveBeenCalledWith({
        url: 'https://s3.amazonaws.com/bucket/report.pdf',
        filename: 'report.pdf',
        size: 17,
        mimetype: 'application/pdf',
      });
      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        expect.any(Buffer),
        'report.pdf',
        mockUserId,
        'application/pdf'
      );
    });

    it('should return 404 for invalid access token', async () => {
      const req = {
        params: { accessToken: 'bad-token' },
        file: { buffer: Buffer.from('x'), originalname: 'f.txt', size: 1, mimetype: 'text/plain' },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue(null);

      await agentModeController.uploadScheduledChatVariableFile(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 410 for expired access token', async () => {
      const req = {
        params: { accessToken: 'expired-token' },
        file: { buffer: Buffer.from('x'), originalname: 'f.txt', size: 1, mimetype: 'text/plain' },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue({
        ...validSchedule,
        variableRequestAccessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      await agentModeController.uploadScheduledChatVariableFile(req, res);

      expect(res.status).toHaveBeenCalledWith(410);
    });

    it('should return 409 for consumed access token', async () => {
      const req = {
        params: { accessToken: 'consumed-token' },
        file: { buffer: Buffer.from('x'), originalname: 'f.txt', size: 1, mimetype: 'text/plain' },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue({
        ...validSchedule,
        variableRequestAccessTokenConsumedAt: '2026-01-01T00:00:00Z',
      });

      await agentModeController.uploadScheduledChatVariableFile(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('should return 400 when no file is uploaded', async () => {
      const req = {
        params: { accessToken: 'valid-upload-token' },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue(validSchedule);

      await agentModeController.uploadScheduledChatVariableFile(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'No file uploaded' });
    });

    it('should return 500 when S3 upload fails', async () => {
      const req = {
        params: { accessToken: 'valid-upload-token' },
        file: { buffer: Buffer.from('x'), originalname: 'f.txt', size: 1, mimetype: 'text/plain' },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduledChatByVariableAccessTokenHash.mockResolvedValue(validSchedule);
      mockUploadFileToS3.mockResolvedValue({ success: false, url: '', key: '' });

      await agentModeController.uploadScheduledChatVariableFile(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('runScheduledChat - file attachments passed to runVerifiedChat', () => {
    const mockSession = {
      sessionId: 'test-session-456',
      userId: mockUserId,
      title: 'Test Session',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const fileVariableValue = JSON.stringify({
      url: 'https://s3.amazonaws.com/bucket/report.pdf',
      filename: 'report.pdf',
      size: 12345,
      mimetype: 'application/pdf',
    });

    beforeEach(() => {
      mockChatbotDb.createChatSession.mockResolvedValue(mockSession);
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
      mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession);
      mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt');
      mockAgentModeService.generateSessionTitle.mockResolvedValue('Test Title');
      mockScheduleDb.addRunResult.mockResolvedValue(undefined);
      mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined);
      mockUserDb.getUserById.mockResolvedValue({ userId: mockUserId, email: 'test@example.com' } as any);
    });

    it('should pass file attachments from file-type variables to runVerifiedChat', async () => {
      // Mock the worker to return a successful response
      mockWorkerService.runInWorker.mockResolvedValue({
        content: 'I processed the report.',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const schedule = {
        scheduleId: 'sched-file-1',
        scheduleName: 'File Test Schedule',
        startingMessage: 'Analyze this report: {{report_file}}',
        variables: [
          { name: 'report_file', description: 'Report to analyze', type: 'file' as const },
        ],
        variableValues: {
          report_file: fileVariableValue,
        },
        keywords: [],
        requiredFunctionCalls: [],
        functionCallMinCalls: {},
        userId: mockUserId,
        nextRunTime: new Date().toISOString(),
      };

      await runScheduledChat(schedule, mockUserId, true);

      // Verify the worker was called with the starting message having the file link
      expect(mockWorkerService.runInWorker).toHaveBeenCalled();
      const workerCall = mockWorkerService.runInWorker.mock.calls[0];
      // The first argument is the params object containing startingMessage
      const callParams = workerCall[0];
      // startingMessage should have the file variable replaced with a markdown link
      expect(callParams.messageContent).toContain('[report.pdf]');
      expect(callParams.messageContent).toContain('https://s3.amazonaws.com/bucket/report.pdf');
    });

    it('should replace file variable with markdown link in starting message', async () => {
      mockWorkerService.runInWorker.mockResolvedValue({
        content: 'Done.',
        toolCalls: [],
        knowledgeBaseQueries: [],
        sources: [],
        responseMessages: [],
      });

      const schedule = {
        scheduleId: 'sched-file-2',
        scheduleName: 'Mixed Variable Types',
        startingMessage: 'Hello {{name}}, analyze {{doc}} and process {{notes}}',
        variables: [
          { name: 'name', description: 'User name', type: 'text' as const },
          { name: 'doc', description: 'Document', type: 'file' as const },
          { name: 'notes', description: 'Notes', type: 'long_text' as const },
        ],
        variableValues: {
          name: 'Alice',
          doc: JSON.stringify({
            url: 'https://s3.example.com/doc.pdf',
            filename: 'doc.pdf',
            size: 5000,
            mimetype: 'application/pdf',
          }),
          notes: 'These are multi-line\nnotes for processing.',
        },
        keywords: [],
        requiredFunctionCalls: [],
        functionCallMinCalls: {},
        userId: mockUserId,
        nextRunTime: new Date().toISOString(),
      };

      await runScheduledChat(schedule, mockUserId, true);

      expect(mockWorkerService.runInWorker).toHaveBeenCalled();
      const callParams = mockWorkerService.runInWorker.mock.calls[0][0];
      // Text variable should be replaced with plain text
      expect(callParams.messageContent).toContain('Hello Alice');
      // File variable should be replaced with markdown link
      expect(callParams.messageContent).toContain('[doc.pdf](https://s3.example.com/doc.pdf)');
      // Long text variable should be replaced with the text value
      expect(callParams.messageContent).toContain('These are multi-line\nnotes for processing.');
    });
  });

  describe('updateScheduledChat - variable type preservation on update', () => {
    it('should preserve variable types when updating a schedule', async () => {
      const existingSchedule = {
        scheduleId: 'sched-update-1',
        scheduleName: 'Existing Schedule',
        startingMessage: 'Hello {{name}} {{doc}}',
        variables: [
          { name: 'name', description: 'Name', type: 'text' },
          { name: 'doc', description: 'Document', type: 'file' },
        ],
        userId: mockUserId,
        scheduleFrequency: 'daily',
        nextRunTime: '2026-03-01T10:00:00Z',
        keywords: [],
        requiredFunctionCalls: [],
        functionCallMinCalls: {},
        emailNotifications: ['test@example.com'],
      };

      const req = {
        user: { userId: mockUserId, email: 'test@example.com' },
        params: { scheduleId: 'sched-update-1' },
        body: {
          scheduleName: 'Updated Schedule',
          startingMessage: 'Hello {{name}} {{doc}}',
          variables: [
            { name: 'name', description: 'Full name', type: 'text' },
            { name: 'doc', description: 'PDF Document', type: 'file' },
          ],
          scheduleFrequency: 'daily',
          nextRunTime: '2026-03-01T10:00:00Z',
          keywords: [],
          requiredFunctionCalls: [],
          functionCallMinCalls: {},
          emailNotifications: ['test@example.com'],
        },
      } as unknown as Request;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as unknown as Response;

      mockScheduleDb.getScheduleById.mockResolvedValue(existingSchedule);
      mockScheduleDb.updateSchedule.mockResolvedValue(undefined);

      await agentModeController.updateScheduledChat(req, res);

      expect(res.json).toHaveBeenCalled();
      const updateCall = mockScheduleDb.updateSchedule.mock.calls[0];
      const updateData = updateCall[1];
      expect(updateData.variables).toEqual([
        { name: 'name', description: 'Full name', type: 'text' },
        { name: 'doc', description: 'PDF Document', type: 'file' },
      ]);
    });
  });
});
