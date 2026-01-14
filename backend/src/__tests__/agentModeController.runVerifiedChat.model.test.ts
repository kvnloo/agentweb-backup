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
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getReportsModel: jest.fn(),
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
    mockChatbotDb.addMessageToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.addMessagesToSession.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionTitle.mockResolvedValue(undefined as any);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue({
      ...baseSession,
      llmModel: 'reports-model',
    } as any);

    mockAgentModeService.getReportsModel.mockResolvedValue('reports-model');
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

  it('switches session to reports model for update_html_file revisions', async () => {
    await runVerifiedChat({
      sessionId: 'session-1',
      userId: 'user-1',
      startingMessage: 'Please revise this HTML report.',
      keywords: [],
      requiredFunctions: [{ functionName: 'update_html_file', minCount: 1 }],
      maxAttempts: 1,
      attachments: [],
    });

    expect(mockAgentModeService.getReportsModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'reports-model');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'reports-model' }),
      expect.any(Function)
    );
  });

  it('switches session to reports model for read_file_content revisions', async () => {
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

    expect(mockAgentModeService.getReportsModel).toHaveBeenCalled();
    expect(mockChatbotDb.updateSessionLlmModel).toHaveBeenCalledWith('session-1', 'reports-model');
    expect(mockWorkerService.runInWorker).toHaveBeenCalledWith(
      expect.objectContaining({ llmModel: 'reports-model' }),
      expect.any(Function)
    );
  });
});
