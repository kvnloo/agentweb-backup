import { runVerifiedChat } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
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
    getReportGenerationDefaultModel: jest.fn(),
    getImageGenerationDefaultModel: jest.fn(),
    getVideoGenerationDefaultModel: jest.fn(),
    getDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    runInWorker: jest.fn(),
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendOncallAlert: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {},
  taskDb: {},
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockWorkerService = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

describe('runVerifiedChat model selection', () => {
  const baseSession = {
    sessionId: 'session-1',
    userId: 'user-1',
    messages: [],
    llmModel: 'default-model',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockChatbotDb.getChatSession.mockResolvedValue(baseSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue({
      ...baseSession,
      llmModel: 'report-gen-model',
    } as any);

    mockAgentModeService.getReportGenerationDefaultModel.mockResolvedValue('report-gen-model');
    mockAgentModeService.getImageGenerationDefaultModel.mockResolvedValue('image-gen-model');
    mockAgentModeService.getVideoGenerationDefaultModel.mockResolvedValue('video-gen-model');
    mockAgentModeService.getDefaultModel.mockResolvedValue('default-model');
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('system prompt');
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title');

    mockWorkerService.runInWorker.mockResolvedValue({
      content: 'Done',
      toolCalls: [{ name: 'update_html_file', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);
  });

  it('switches session to report generation model for update_html_file', async () => {
    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Please revise this HTML report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(mockAgentModeService.getReportGenerationDefaultModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'report-gen-model');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'report-gen-model' }),
      expect.any(Function)
    );
  });

  it('switches session to report generation model for read_file_content', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce({
      content: 'Done',
      toolCalls: [{ name: 'read_file_content', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Please apply revisions.',
      keywords: [],
      requiredFunctions: [{ functionName: 'read_file_content', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(mockAgentModeService.getReportGenerationDefaultModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'report-gen-model');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'report-gen-model' }),
      expect.any(Function)
    );
  });

  it('switches session to report generation model for create_blog_article', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce({
      content: 'Done',
      toolCalls: [{ name: 'create_blog_article', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Create a new report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'create_blog_article', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(mockAgentModeService.getReportGenerationDefaultModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'report-gen-model');
  });

  it('switches session to image generation model for generate_image', async () => {
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue({
      ...baseSession,
      llmModel: 'image-gen-model',
    } as any);

    mockWorkerService.runInWorker.mockResolvedValueOnce({
      content: 'Done',
      toolCalls: [{ name: 'generate_image', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Generate an image.',
      keywords: [],
      requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(mockAgentModeService.getImageGenerationDefaultModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'image-gen-model');
  });

  it('switches session to video generation model for generate_video', async () => {
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue({
      ...baseSession,
      llmModel: 'video-gen-model',
    } as any);

    mockWorkerService.runInWorker.mockResolvedValueOnce({
      content: 'Done',
      toolCalls: [{ name: 'generate_video', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Generate a video.',
      keywords: [],
      requiredFunctions: [{ functionName: 'generate_video', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(mockAgentModeService.getVideoGenerationDefaultModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'video-gen-model');
  });

  it('does not override model when llmModel is explicitly provided (generate_image)', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce({
      content: 'Done',
      toolCalls: [{ name: 'generate_image', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Generate an image.',
      keywords: [],
      requiredFunctions: [{ functionName: 'generate_image', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
      llmModel: 'anthropic.claude-sonnet-4-6',
    });

    expect(mockAgentModeService.getImageGenerationDefaultModel).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'anthropic.claude-sonnet-4-6' }),
      expect.any(Function)
    );
  });

  it('does not override model when llmModel is explicitly provided (update_html_file)', async () => {
    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Please revise this report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
      llmModel: 'anthropic.claude-sonnet-4-6',
    });

    expect(mockAgentModeService.getReportGenerationDefaultModel).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'anthropic.claude-sonnet-4-6' }),
      expect.any(Function)
    );
  });

  it('does not override model when llmModel is explicitly provided (generate_video)', async () => {
    mockWorkerService.runInWorker.mockResolvedValueOnce({
      content: 'Done',
      toolCalls: [{ name: 'generate_video', result: { success: true } }],
      knowledgeBaseQueries: [],
      sources: [],
      responseMessages: [],
    } as any);

    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Generate a video.',
      keywords: [],
      requiredFunctions: [{ functionName: 'generate_video', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
      llmModel: 'anthropic.claude-sonnet-4-6',
    });

    expect(mockAgentModeService.getVideoGenerationDefaultModel).not.toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).not.toHaveBeenCalled();
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'anthropic.claude-sonnet-4-6' }),
      expect.any(Function)
    );
  });
});
