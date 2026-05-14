import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
  })),
}));

describe('AgentModeService - List Meta Ads Campaigns', () => {
  let agentModeService: AgentModeService;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  describe('listMetaAdsCampaigns', () => {
    it('should successfully fetch and return campaigns', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return campaign data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/campaigns')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                {
                  id: '120208234567890123',
                  name: 'Holiday Campaign 2023',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_LEADS'
                },
                {
                  id: '120208234567890124',
                  name: 'Brand Awareness Campaign',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_AWARENESS'
                },
                {
                  id: '120208234567890125',
                  name: 'Retargeting Campaign',
                  status: 'PAUSED',
                  objective: 'OUTCOME_SALES'
                }
              ]
            })
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Found 3 campaign(s)');
      expect(result.campaigns).toHaveLength(3);
      expect(result.totalCount).toBe(3);

      // Verify campaign data structure
      expect(result.campaigns[0]).toEqual({
        id: '120208234567890123',
        name: 'Holiday Campaign 2023',
        status: 'ACTIVE',
        objective: 'OUTCOME_LEADS'
      });

      expect(result.campaigns[1]).toEqual({
        id: '120208234567890124',
        name: 'Brand Awareness Campaign',
        status: 'ACTIVE',
        objective: 'OUTCOME_AWARENESS'
      });

      expect(result.campaigns[2]).toEqual({
        id: '120208234567890125',
        name: 'Retargeting Campaign',
        status: 'PAUSED',
        objective: 'OUTCOME_SALES'
      });
    });

    it('should return empty array when no campaigns exist', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return empty campaigns
      global.fetch = jest.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Found 0 campaign(s)');
      expect(result.campaigns).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('should return error when user is not found', async () => {
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('User not found');
      expect(result.error).toBe('User not found');
    });

    it('should return error when ad account is not configured', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: ''
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Ad account not configured. Please configure your Meta ad account first.');
      expect(result.error).toBe('Ad account not configured');
    });

    it('should return error when access token cannot be fetched', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const { getMetaAccessToken } = await import('../utils/secretsManager');
      (getMetaAccessToken as jest.Mock).mockRejectedValueOnce(new Error('Failed to fetch token'));

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Meta access token not configured. Please contact your administrator.');
      expect(result.error).toBe('Failed to fetch token');
    });

    it('should return error when Meta API returns an error', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return API error
      global.fetch = jest.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({
            error: {
              message: 'Invalid OAuth access token'
            }
          })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to fetch campaigns');
      expect(result.error).toBe('Invalid OAuth access token');
    });

    it('should handle pagination and return all campaigns', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let callCount = 0;

      // Mock fetch to return paginated data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        callCount++;

        if (url.includes('/campaigns') && !url.includes('after=')) {
          // First page
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                {
                  id: 'camp1',
                  name: 'Campaign 1',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_LEADS'
                },
                {
                  id: 'camp2',
                  name: 'Campaign 2',
                  status: 'ACTIVE',
                  objective: 'OUTCOME_SALES'
                }
              ],
              paging: {
                next: 'https://graph.facebook.com/v25.0/act_123456789/campaigns?after=cursor123'
              }
            })
          });
        }

        if (url.includes('after=cursor123')) {
          // Second page
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [
                {
                  id: 'camp3',
                  name: 'Campaign 3',
                  status: 'PAUSED',
                  objective: 'OUTCOME_AWARENESS'
                }
              ]
            })
          });
        }

        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [] })
        });
      }) as jest.Mock;

      const result = await agentModeService['listMetaAdsCampaigns']('user123');

      expect(result.success).toBe(true);
      expect(result.campaigns).toHaveLength(3);
      expect(result.totalCount).toBe(3);
      expect(callCount).toBeGreaterThan(1); // Should have made multiple calls for pagination
    });
  });
});
