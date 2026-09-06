import { AgentModeService } from '../services/agentModeService';
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';

function makeAxiosError(status: number, message = 'Request failed') {
  const err: any = new Error(message);
  err.response = { status };
  return err;
}

jest.mock('@google-cloud/storage');
jest.mock('../utils/secretsManager');
jest.mock('axios');

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

const mockGetAccessToken = jest.fn();
const mockListBoards = jest.fn();
const mockGetAllBoardAds = jest.fn();
const mockGetSwipefileAds = jest.fn();
const mockSearchDiscoveryAds = jest.fn();
const mockGetAd = jest.fn();
jest.mock('../services/foreplayService', () => ({
  getAccessToken: (...args: any[]) => mockGetAccessToken(...args),
  listBoards: (...args: any[]) => mockListBoards(...args),
  getAllBoardAds: (...args: any[]) => mockGetAllBoardAds(...args),
  getSwipefileAds: (...args: any[]) => mockGetSwipefileAds(...args),
  searchDiscoveryAds: (...args: any[]) => mockSearchDiscoveryAds(...args),
  getAd: (...args: any[]) => mockGetAd(...args),
  formatAdAsMarkdown: (ad: any) => `# ${ad.name || ad.headline || ad.id}\n\n${ad.brandName || ''}`,
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

describe('AgentModeService - Foreplay', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    await agentModeService.initialize();
    mockGetAccessToken.mockResolvedValue('foreplay-token');
  });

  const expectAuthConfig = (result: any) => {
    const classified = toolResultError(result);
    expect(classifyToolErrorClass(classified)).toBe('auth');
    expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
  };

  describe('searchForeplayAds', () => {
    it('should return matching swipefile ads', async () => {
      mockGetSwipefileAds.mockResolvedValue({
        ads: [{ id: 'ad-1', name: 'Summer Sale', brandName: 'Acme' }],
      });
      mockListBoards.mockResolvedValue([]);

      const result = await agentModeService.searchForeplayAds('summer', 5, 'user-123');
      expect(result.success).toBe(true);
      expect(result.totalResults).toBe(1);
    });

    it('should report a genuine empty match as success when both sources return cleanly with no matches', async () => {
      mockGetSwipefileAds.mockResolvedValue({ ads: [] });
      mockListBoards.mockResolvedValue([]);

      const result = await agentModeService.searchForeplayAds('nonexistent', 5, 'user-123');
      expect(result.success).toBe(true);
      expect(result.message).toContain('No Foreplay ads found');
    });

    // ENG-1300: both the swipefile fetch and the boards list are individually
    // try/caught and swallowed (so one bad board never sinks the others) — which
    // meant a total auth/rate-limit failure on EVERY source was silently reported
    // as "No Foreplay ads found" (success:true) rather than surfaced as the
    // failure it is. Proves a coded failure with zero results now reports
    // success:false with the real status, while a genuinely empty match (above)
    // still reports success:true.
    it('ENG-1300: a 401 on every source classifies as auth/config instead of a false-success empty result', async () => {
      mockGetSwipefileAds.mockRejectedValue(makeAxiosError(401, 'Invalid API key'));
      mockListBoards.mockRejectedValue(makeAxiosError(401, 'Invalid API key'));

      const result = await agentModeService.searchForeplayAds('summer', 5, 'user-123');
      expect(result.success).toBe(false);
      expect(result.code).toBe(401);
      expectAuthConfig(result);
    });

    it('does not let one bad board suppress results found from other boards', async () => {
      mockGetSwipefileAds.mockResolvedValue({ ads: [] });
      mockListBoards.mockResolvedValue([
        { id: 'board-1', name: 'Broken Board' },
        { id: 'board-2', name: 'Good Board' },
      ]);
      mockGetAllBoardAds.mockImplementation((token: string, boardId: string) => {
        if (boardId === 'board-1') return Promise.reject(makeAxiosError(500, 'Board unavailable'));
        return Promise.resolve([{ id: 'ad-2', name: 'Winter Sale', brandName: 'Acme' }]);
      });

      const result = await agentModeService.searchForeplayAds('winter', 5, 'user-123');
      expect(result.success).toBe(true);
      expect(result.totalResults).toBe(1);
    });

    it('should handle outer errors (e.g. token lookup failure)', async () => {
      mockGetAccessToken.mockRejectedValue(makeAxiosError(403, 'Forbidden'));

      const result = await agentModeService.searchForeplayAds('summer', 5, 'user-123');
      expect(result.success).toBe(false);
      expect(result.code).toBe(403);
      expectAuthConfig(result);
    });
  });

  describe('searchForeplayDiscovery', () => {
    it('ENG-1300: a 403 classifies as auth/config end-to-end', async () => {
      mockSearchDiscoveryAds.mockRejectedValue(makeAxiosError(403, 'Forbidden'));

      const result = await agentModeService.searchForeplayDiscovery('summer', {}, 'user-123');
      expect(result.success).toBe(false);
      expect(result.code).toBe(403);
      expectAuthConfig(result);
    });
  });

  describe('readForeplayAd', () => {
    it('ENG-1300: a 403 classifies as auth/config end-to-end', async () => {
      mockGetSwipefileAds.mockRejectedValue(makeAxiosError(403, 'Forbidden'));

      const result = await (agentModeService as any).readForeplayAd('foreplay-swipefile', 'My Ad', 'user-123');
      expect(result.success).toBe(false);
      expect(result.code).toBe(403);
      expectAuthConfig(result);
    });
  });
});
