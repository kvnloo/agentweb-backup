import { AgentModeService } from '../services/agentModeService';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';

jest.mock('@google-cloud/storage');
jest.mock('../utils/secretsManager');
jest.mock('axios');

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

const mockSearch = jest.fn();
jest.mock('../search/googleSearchProvider', () => ({
  GoogleSearchProvider: jest.fn().mockImplementation(() => ({
    search: (...args: any[]) => mockSearch(...args),
  })),
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn().mockResolvedValue([]),
    getAllPublicKnowledgeBaseTasks: jest.fn().mockResolvedValue([]),
    getTaskById: jest.fn(),
  },
}));

jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn(),
  decryptPassword: jest.fn(),
}));

describe('AgentModeService - googleSearchWeb', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
  });

  it('should return results on success', async () => {
    mockSearch.mockResolvedValue({
      provider: 'google',
      query: 'test',
      results: [{ title: 'A', url: 'https://a.com', snippet: '...', sourceType: 'web' }],
      metadata: { provider: 'google', resultSource: 'web' },
    });

    const result = await agentModeService.googleSearchWeb('test', 5);
    expect(result.success).toBe(true);
    expect(result.totalResults).toBe(1);
  });

  // ENG-1300: googleapis' customsearch client throws a GaxiosError, whose .code
  // is genuinely the numeric HTTP status (unlike Meta's business-code .code) —
  // same convention already established for Drive/Calendar in this project.
  it('ENG-1300: a 403 (GaxiosError .code) classifies as auth/config end-to-end', async () => {
    const gaxiosError: any = new Error('Access Not Configured');
    gaxiosError.code = 403;
    mockSearch.mockRejectedValue(gaxiosError);

    const result = await agentModeService.googleSearchWeb('test', 5);

    expect(result.success).toBe(false);
    expect(result.code).toBe(403);
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  });

  it('ENG-1300: a 429 (axios response.status shape) classifies as rate_limit', async () => {
    const err: any = new Error('Quota exceeded');
    err.response = { status: 429 };
    mockSearch.mockRejectedValue(err);

    const result = await agentModeService.googleSearchWeb('test', 5);

    expect(result.success).toBe(false);
    expect(result.code).toBe(429);
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('rate_limit');
  });
});
