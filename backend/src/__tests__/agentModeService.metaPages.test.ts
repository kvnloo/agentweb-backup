// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// Mock the dependencies
jest.mock('../services/metaService', () => ({
  metaService: {
    getPages: jest.fn()
  }
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { userDb } from '../services/db';

describe('AgentModeService - Meta Pages', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('listMetaPages', () => {
    it('should successfully fetch and return pages', async () => {
      const mockUser = {
        id: 'user123',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      const mockPages = [
        {
          id: 'page_123',
          name: 'Test Page 1',
          access_token: 'page_token_123',
          category: 'Business',
          tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT']
        },
        {
          id: 'page_456',
          name: 'Test Page 2',
          access_token: 'page_token_456',
          category: 'Brand',
          tasks: ['ADVERTISE', 'MODERATE']
        }
      ];

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getPages as jest.Mock).mockResolvedValue(mockPages);

      const result = await agentModeService.listMetaPages('user123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Found 2 Facebook Page(s)');
      expect(result.pages).toEqual(mockPages);
      expect(result.totalCount).toBe(2);
      expect(metaService.getPages).toHaveBeenCalledWith('mock-access-token');
    });

    it('should return empty array when no pages exist', async () => {
      const mockUser = {
        id: 'user123',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getPages as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.listMetaPages('user123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Found 0 Facebook Page(s)');
      expect(result.pages).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it('should throw when user is not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      await expect(agentModeService.listMetaPages('user123')).rejects.toThrow('User not found');
    });

    it('should throw when Meta ad account not connected', async () => {
      const mockUser = {
        id: 'user123',
        connected_accounts: []
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      await expect(agentModeService.listMetaPages('user123')).rejects.toThrow('Meta Ads account is not connected');
    });

    it('should handle metaService errors', async () => {
      const mockUser = {
        id: 'user123',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Test Business',
            config: {
              account_type: 'ad_account',
              access_token: 'mock-access-token',
              ad_account_id: '123456789'
            }
          }
        ]
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getPages as jest.Mock).mockRejectedValue(new Error('Invalid OAuth access token'));

      const result = await agentModeService.listMetaPages('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid OAuth access token');
      expect(result.error).toBe('Invalid OAuth access token');
    });

    it('should use specified account_id when provided', async () => {
      const mockUser = {
        id: 'user123',
        connected_accounts: [
          {
            platform: 'meta',
            account_id: '123456789',
            account_name: 'Account 1',
            config: {
              account_type: 'ad_account',
              access_token: 'token1',
              ad_account_id: '123456789'
            }
          },
          {
            platform: 'meta',
            account_id: '987654321',
            account_name: 'Account 2',
            config: {
              account_type: 'ad_account',
              access_token: 'token2',
              ad_account_id: '987654321'
            }
          }
        ]
      };

      const mockPages = [{ id: 'page_1', name: 'Page 1' }];

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getPages as jest.Mock).mockResolvedValue(mockPages);

      const result = await agentModeService.listMetaPages('user123', '987654321');

      expect(result.success).toBe(true);
      expect(metaService.getPages).toHaveBeenCalledWith('token2');
    });
  });
});
