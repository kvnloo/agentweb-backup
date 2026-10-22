// Mock dependencies BEFORE importing
jest.mock('../services/db');
jest.mock('../services/chatbotService');
jest.mock('../services/agentModeService');
jest.mock('../services/generateMarketingResponseWorkerService');
jest.mock('../services/skillService');

import { Request, Response } from 'express';
import { benchmarkTestDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { skillService } from '../services/skillService';
import {
  createBenchmarkTest,
  runBenchmarkTest,
  updateBenchmarkTest,
} from '../controllers/benchmark';
import { AuthenticatedRequest } from '../middleware/auth';

// Mock the dependencies
const mockBenchmarkTestDb = benchmarkTestDb as jest.Mocked<typeof benchmarkTestDb>;
const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGenerateMarketingResponseWorkerService = generateMarketingResponseWorkerService as jest.Mocked<
  typeof generateMarketingResponseWorkerService
>;
const mockSkillService = skillService as jest.Mocked<typeof skillService>;

describe('Benchmark Controller - Model Selection', () => {
  let mockReq: Partial<AuthenticatedRequest>;
  let mockRes: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockReq = {
      user: {
        userId: 'admin-123',
        isAdmin: true,
        email: 'admin@test.com',
      },
      body: {},
      params: {},
    };

    mockRes = {
      status: statusMock,
      json: jsonMock,
    };

    // Set default model
    mockAgentModeService.default_model = 'gpt-5-chat-2';
    mockAgentModeService.getDefaultModel.mockResolvedValue(mockAgentModeService.default_model);

    // Mock skillService for pre-installing skills in runBenchmarkTest
    mockSkillService.getPublishedSkills.mockResolvedValue([]);
    mockAgentModeService.installSkills.mockResolvedValue(undefined as any);
  });

  describe('createBenchmarkTest', () => {
    it('should create test with provided llmModel', async () => {
      const sessionId = 'session-123';
      const testName = 'Test Name';
      const llmModel = 'gpt-5-chat-2';

      const mockSession = {
        sessionId,
        userId: 'user-456',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      };

      const mockTest = {
        testId: 'test-789',
        createdBy: 'admin-123',
        sessionId,
        userId: 'user-456',
        testName,
        conversationHistory: {
          messages: mockSession.messages,
        },
        expectedOutput: {
          keywords: ['keyword1'],
        },
        status: 'draft',
        llmModel,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      mockChatbotDb.getChatSession = jest.fn().mockResolvedValue(mockSession);
      mockBenchmarkTestDb.createBenchmarkTest = jest.fn().mockResolvedValue(mockTest);

      mockReq.body = {
        sessionId,
        testName,
        expectedOutput: {
          keywords: ['keyword1'],
        },
        llmModel,
      };

      await createBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockBenchmarkTestDb.createBenchmarkTest).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel,
        })
      );
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Benchmark test created successfully',
          testId: expect.any(String),
          benchmarkTest: expect.objectContaining({
            llmModel,
            testName,
            sessionId,
            userId: 'user-456',
          }),
        })
      );
    });

    it('should use default model if llmModel not provided', async () => {
      const sessionId = 'session-123';
      const testName = 'Test Name';

      const mockSession = {
        sessionId,
        userId: 'user-456',
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      };

      const mockTest = {
        testId: 'test-789',
        createdBy: 'admin-123',
        sessionId,
        userId: 'user-456',
        testName,
        conversationHistory: {
          messages: mockSession.messages,
        },
        expectedOutput: {},
        status: 'draft',
        llmModel: mockAgentModeService.default_model,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      };

      mockChatbotDb.getChatSession = jest.fn().mockResolvedValue(mockSession);
      mockBenchmarkTestDb.createBenchmarkTest = jest.fn().mockResolvedValue(mockTest);

      mockReq.body = {
        sessionId,
        testName,
        expectedOutput: {},
      };

      await createBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockBenchmarkTestDb.createBenchmarkTest).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: mockAgentModeService.default_model,
        })
      );
    });
  });

  describe('runBenchmarkTest', () => {
    it('should use saved llmModel from test when no override provided', async () => {
      const testId = 'test-123';
      const savedModel = 'gpt-5-chat-2';

      const mockTest = {
        testId,
        testName: 'Test Name',
        status: 'active',
        userId: 'user-456',
        sessionId: 'session-789',
        llmModel: savedModel,
        conversationHistory: {
          messages: [
            { role: 'user', content: 'Hello' },
          ],
        },
        expectedOutput: {
          keywords: ['keyword1'],
        },
      };

      const mockAgentResponse = {
        content: 'Response content',
        toolCalls: [],
        responseMessages: [],
      };

      const mockResult = {
        testId,
        runId: 'run-456',
        status: 'success',
        passed: true,
        actualResponse: 'Response content',
        actualFunctionCalls: [],
        keywordMatches: ['keyword1'],
        keywordMisses: [],
        functionCallMatches: [],
        functionCallMisses: [],
        executionTime: 100,
        llmModel: savedModel,
        createdAt: new Date().toISOString(),
      };

      mockBenchmarkTestDb.getBenchmarkTest = jest.fn().mockResolvedValue(mockTest);
      mockGenerateMarketingResponseWorkerService.runInWorker = jest.fn().mockResolvedValue(mockAgentResponse);
      mockBenchmarkTestDb.incrementRunCount = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.addTestResult = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.updateBenchmarkTest = jest.fn().mockResolvedValue({});

      mockReq.params = { testId };
      mockReq.body = {};

      await runBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: savedModel,
        })
      );
      expect(mockBenchmarkTestDb.addTestResult).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          llmModel: savedModel,
        })
      );
      expect(mockBenchmarkTestDb.updateBenchmarkTest).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          lastRunModel: savedModel,
        })
      );
    });

    it('should use override llmModel when provided', async () => {
      const testId = 'test-123';
      const savedModel = 'gpt-5-chat-2';
      const overrideModel = 'gemini-3-pro-preview';

      const mockTest = {
        testId,
        testName: 'Test Name',
        status: 'active',
        userId: 'user-456',
        sessionId: 'session-789',
        llmModel: savedModel,
        conversationHistory: {
          messages: [
            { role: 'user', content: 'Hello' },
          ],
        },
        expectedOutput: {
          keywords: ['keyword1'],
        },
      };

      const mockAgentResponse = {
        content: 'Response content',
        toolCalls: [],
        responseMessages: [],
      };

      mockBenchmarkTestDb.getBenchmarkTest = jest.fn().mockResolvedValue(mockTest);
      mockGenerateMarketingResponseWorkerService.runInWorker = jest.fn().mockResolvedValue(mockAgentResponse);
      mockBenchmarkTestDb.incrementRunCount = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.addTestResult = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.updateBenchmarkTest = jest.fn().mockResolvedValue({});

      mockReq.params = { testId };
      mockReq.body = { llmName: overrideModel };

      await runBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: overrideModel,
        })
      );
      expect(mockBenchmarkTestDb.addTestResult).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          llmModel: overrideModel,
        })
      );
      expect(mockBenchmarkTestDb.updateBenchmarkTest).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          lastRunModel: overrideModel,
        })
      );
    });

    it('should use default model when test has no saved model and no override', async () => {
      const testId = 'test-123';

      const mockTest = {
        testId,
        testName: 'Test Name',
        status: 'active',
        userId: 'user-456',
        sessionId: 'session-789',
        // No llmModel
        conversationHistory: {
          messages: [
            { role: 'user', content: 'Hello' },
          ],
        },
        expectedOutput: {
          keywords: ['keyword1'],
        },
      };

      const mockAgentResponse = {
        content: 'Response content',
        toolCalls: [],
        responseMessages: [],
      };

      mockBenchmarkTestDb.getBenchmarkTest = jest.fn().mockResolvedValue(mockTest);
      mockGenerateMarketingResponseWorkerService.runInWorker = jest.fn().mockResolvedValue(mockAgentResponse);
      mockBenchmarkTestDb.incrementRunCount = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.addTestResult = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.updateBenchmarkTest = jest.fn().mockResolvedValue({});

      mockReq.params = { testId };
      mockReq.body = {};

      await runBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockGenerateMarketingResponseWorkerService.runInWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: mockAgentModeService.default_model,
        })
      );
      expect(mockBenchmarkTestDb.addTestResult).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          llmModel: mockAgentModeService.default_model,
        })
      );
    });

    it('should save lastRunModel even on failure', async () => {
      const testId = 'test-123';
      const modelToUse = 'gpt-5-chat-2';

      const mockTest = {
        testId,
        testName: 'Test Name',
        status: 'active',
        userId: 'user-456',
        sessionId: 'session-789',
        llmModel: modelToUse,
        conversationHistory: {
          messages: [
            { role: 'user', content: 'Hello' },
          ],
        },
        expectedOutput: {
          keywords: ['keyword1'],
        },
      };

      const executionError = new Error('Execution failed');

      mockBenchmarkTestDb.getBenchmarkTest = jest.fn().mockResolvedValue(mockTest);
      mockGenerateMarketingResponseWorkerService.runInWorker = jest.fn().mockRejectedValue(executionError);
      mockBenchmarkTestDb.incrementRunCount = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.addTestResult = jest.fn().mockResolvedValue({});
      mockBenchmarkTestDb.updateBenchmarkTest = jest.fn().mockResolvedValue({});

      mockReq.params = { testId };
      mockReq.body = {};

      await runBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockBenchmarkTestDb.addTestResult).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          llmModel: modelToUse,
        })
      );
      expect(mockBenchmarkTestDb.updateBenchmarkTest).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          lastRunModel: modelToUse,
        })
      );
    });
  });

  describe('updateBenchmarkTest', () => {
    it('should update test with llmModel', async () => {
      const testId = 'test-123';
      const llmModel = 'gpt-5-chat-2';

      const mockUpdatedTest = {
        testId,
        testName: 'Updated Test',
        llmModel,
        updatedAt: new Date().toISOString(),
      };

      mockBenchmarkTestDb.updateBenchmarkTest = jest.fn().mockResolvedValue(mockUpdatedTest);

      mockReq.params = { testId };
      mockReq.body = {
        testName: 'Updated Test',
        llmModel,
      };

      await updateBenchmarkTest(mockReq as AuthenticatedRequest, mockRes as Response);

      expect(mockBenchmarkTestDb.updateBenchmarkTest).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({
          llmModel,
        })
      );
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          test: expect.objectContaining({
            llmModel,
          }),
        })
      );
    });
  });
});

describe('ENG-669 PR-C: the AgentWeb Model cannot be benchmarked (refused, never run on the default)', () => {
  const res = () => {
    const json = jest.fn().mockReturnThis();
    const status = jest.fn().mockReturnValue({ json });
    return { status, json } as any;
  };
  const admin = { userId: 'admin-123', isAdmin: true, email: 'admin@test.com' };
  const refusal = { message: 'AgentWeb Model picks a model per chat turn and can\'t be benchmarked. Choose a specific model.', code: 'agentweb_model_not_benchmarkable' };

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['create', () => createBenchmarkTest({ user: admin, body: { sessionId: 's', testName: 't', llmModel: 'agentweb-model' }, params: {} } as any, (globalThis as any).__r = res())],
    ['update', () => updateBenchmarkTest({ user: admin, body: { llmModel: 'agentweb-model' }, params: { testId: 't1' } } as any, (globalThis as any).__r = res())],
    ['run', () => runBenchmarkTest({ user: admin, body: { llmName: 'agentweb-model' }, params: { testId: 't1' } } as any, (globalThis as any).__r = res())],
  ])('%s: 400 before any read or run', async (_label, call) => {
    await call();
    const r = (globalThis as any).__r;
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.status.mock.results[0].value.json).toHaveBeenCalledWith(refusal);
    expect(mockGenerateMarketingResponseWorkerService.runInWorker).not.toHaveBeenCalled();
  });
});
