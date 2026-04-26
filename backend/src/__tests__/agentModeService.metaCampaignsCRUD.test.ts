// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

// Mock the dependencies
jest.mock('../services/metaService', () => ({
  metaService: {
    createCampaign: jest.fn(),
    updateCampaign: jest.fn(),
    deleteCampaign: jest.fn(),
    listCampaigns: jest.fn()
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

describe('AgentModeService - Meta Campaign CRUD', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

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

  describe('listMetaAdsCampaigns', () => {
    it('should successfully list campaigns', async () => {
      const mockCampaigns = [
        { id: 'camp_1', name: 'Campaign 1' },
        { id: 'camp_2', name: 'Campaign 2' }
      ];

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listCampaigns as jest.Mock).mockResolvedValue(mockCampaigns);

      const result = await agentModeService.listMetaAdsCampaignsNew('user123');

      expect(result.success).toBe(true);
      expect(result.message).toBe('Found 2 campaign(s)');
      expect(result.campaigns).toEqual(mockCampaigns);
      expect(result.totalCount).toBe(2);
      expect(metaService.listCampaigns).toHaveBeenCalledWith('123456789', 'mock-access-token');
    });
  });

  describe('createMetaAdsCampaign', () => {
    it('should successfully create a campaign', async () => {
      const mockCampaignData = {
        id: 'camp_123',
        name: 'Test Campaign'
      };

      const params = {
        name: 'Test Campaign',
        objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED',
        special_ad_categories: []
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.createCampaign as jest.Mock).mockResolvedValue(mockCampaignData);

      const result = await agentModeService.createMetaAdsCampaign('user123', params);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign "Test Campaign" created successfully');
      expect(result.campaign).toEqual(mockCampaignData);
      expect(metaService.createCampaign).toHaveBeenCalledWith('123456789', 'mock-access-token', params);
    });

    it('should use account_id from params if provided', async () => {
      const mockCampaignData = { id: 'camp_123', name: 'Test Campaign' };
      const params = {
        name: 'Test Campaign',
        objective: 'OUTCOME_TRAFFIC',
        account_id: '987654321'
      };

      const multiAccountUser = {
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

      (userDb.getUserById as jest.Mock).mockResolvedValue(multiAccountUser);
      (metaService.createCampaign as jest.Mock).mockResolvedValue(mockCampaignData);

      const result = await agentModeService.createMetaAdsCampaign('user123', params);

      expect(result.success).toBe(true);
      expect(metaService.createCampaign).toHaveBeenCalledWith('987654321', 'token2', expect.any(Object));
    });

    it('should handle errors', async () => {
      const params = { name: 'Test Campaign', objective: 'OUTCOME_TRAFFIC' };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.createCampaign as jest.Mock).mockRejectedValue(new Error('Invalid parameters'));

      const result = await agentModeService.createMetaAdsCampaign('user123', params);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid parameters');
      expect(result.error).toBe('Invalid parameters');
    });
  });

  describe('updateMetaAdsCampaign', () => {
    it('should successfully update a campaign', async () => {
      const campaignId = 'camp_123';
      const params = { name: 'Updated Campaign Name', status: 'ACTIVE' };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

      const result = await agentModeService.updateMetaAdsCampaign('user123', campaignId, params);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign updated successfully');
      expect(metaService.updateCampaign).toHaveBeenCalledWith('mock-access-token', campaignId, params);
    });

    it('should use specified account_id when provided', async () => {
      const multiAccountUser = {
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

      (userDb.getUserById as jest.Mock).mockResolvedValue(multiAccountUser);
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });

      const result = await agentModeService.updateMetaAdsCampaign(
        'user123',
        'camp_123',
        { name: 'Updated' },
        '987654321'
      );

      expect(result.success).toBe(true);
      expect(metaService.updateCampaign).toHaveBeenCalledWith('token2', 'camp_123', { name: 'Updated' });
    });

    it('should handle errors', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.updateCampaign as jest.Mock).mockRejectedValue(new Error('Campaign not found'));

      const result = await agentModeService.updateMetaAdsCampaign('user123', 'camp_123', { status: 'ACTIVE' });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Campaign not found');
    });
  });

  describe('deleteMetaAdsCampaign', () => {
    it('should successfully delete a campaign', async () => {
      const campaignId = 'camp_123';

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.deleteCampaign as jest.Mock).mockResolvedValue({ success: true });

      const result = await agentModeService.deleteMetaAdsCampaign('user123', campaignId);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign deleted successfully');
      expect(metaService.deleteCampaign).toHaveBeenCalledWith('mock-access-token', campaignId);
    });

    it('should use specified account_id when provided', async () => {
      const multiAccountUser = {
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

      (userDb.getUserById as jest.Mock).mockResolvedValue(multiAccountUser);
      (metaService.deleteCampaign as jest.Mock).mockResolvedValue({ success: true });

      const result = await agentModeService.deleteMetaAdsCampaign('user123', 'camp_123', '987654321');

      expect(result.success).toBe(true);
      expect(metaService.deleteCampaign).toHaveBeenCalledWith('token2', 'camp_123');
    });

    it('should handle errors', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.deleteCampaign as jest.Mock).mockRejectedValue(new Error('Permission denied'));

      const result = await agentModeService.deleteMetaAdsCampaign('user123', 'camp_123');

      expect(result.success).toBe(false);
      expect(result.message).toBe('Permission denied');
    });

    it('should throw when user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      await expect(agentModeService.deleteMetaAdsCampaign('user123', 'camp_123')).rejects.toThrow('User not found');
    });
  });
});
