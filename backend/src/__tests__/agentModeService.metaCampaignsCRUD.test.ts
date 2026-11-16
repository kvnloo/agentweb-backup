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
    getCampaign: jest.fn(), // ENG-3065: updates and deletes are read back
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
import { toolResultError } from '../utils/toolResultError';
import { classifyToolErrorClass } from '../utils/toolErrorClassifier';
import { classifyToolFailureType } from '../utils/toolFailureType';

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
      (metaService.listCampaigns as jest.Mock).mockResolvedValue({
        campaigns: mockCampaigns,
        truncated: false,
        pagesFetched: 1,
      });

      const result = await agentModeService.listMetaAdsCampaignsNew('user123');

      expect(result.success).toBe(true);
      // ENG-1625: bare "Found N campaign(s)" was the ENG-1476/ENG-1584 sentence shape —
      // the message now names scope and completeness explicitly.
      expect(result.message).toBe('Found 2 campaign(s) in this ad account (complete list).');
      expect(result.campaigns).toEqual(mockCampaigns);
      expect(result.totalCount).toBe(2);
      expect(result.complete).toBe(true);
      expect(result.hasMore).toBe(false);
      expect(metaService.listCampaigns).toHaveBeenCalledWith('123456789', 'mock-access-token');
    });

    it('forwards Meta structuredError as details when listing fails (ENG-394)', async () => {
      const metaErr: any = new Error('An unexpected error has occurred. Please retry your request later.');
      metaErr.structuredError = {
        message: metaErr.message,
        code: 2,
        fbtrace_id: 'ASaXJM0Tf2Rt',
        classification: 'RETRYABLE_ERROR'
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaErr);

      const result = await agentModeService.listMetaAdsCampaignsNew('user123');

      expect(result.success).toBe(false);
      // Diagnostics (Meta code / fbtrace_id / classification) survive to telemetry,
      // matching the sibling createMetaAdsCampaign path — not dropped as a bare string.
      expect(result.details).toEqual(metaErr.structuredError);
    });

    // ENG-1300: the exact misclassification trap this fix exists to avoid. Meta's
    // own business error codes (structuredError.code, e.g. "404" as a Meta-internal
    // code, NOT the HTTP status "Not Found") coincidentally overlap the 100-599 HTTP
    // range. `code` on the result must come from error.status / error.response.status
    // ONLY — never from structuredError.code — or a coincidental business code would
    // silently masquerade as a transport status.
    it('ENG-1300: a Meta business error code (structuredError.code) is never misread as the HTTP status', async () => {
      // Deliberately a message with NO independent classifyToolErrorClass message-text
      // match (unlike e.g. "Object does not exist" -> classFromMessage's 'not found'
      // pattern) — this test isolates the numeric-code path specifically, so a
      // leaked business code is the ONLY way this could classify as 'not_found'.
      const metaErr: any = new Error('Unexpected Meta response');
      metaErr.structuredError = {
        message: metaErr.message,
        code: 404, // Meta business code — coincidentally in the HTTP range, but NOT an HTTP status here.
        classification: 'UNKNOWN_ERROR',
      };
      // Deliberately no `.status` / `.response.status` — this error carries no real
      // transport status at all.

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listCampaigns as jest.Mock).mockRejectedValue(metaErr);

      const result = await agentModeService.listMetaAdsCampaignsNew('user123');

      expect(result.success).toBe(false);
      // No real HTTP status was ever present, so `code` must stay unset — not
      // silently backfilled from the business code.
      expect(result.code).toBeUndefined();
      const classified = toolResultError(result);
      // Had the business code leaked through as `code`, classFromStatus(404) would
      // have forced 'not_found'. With no numeric status and no message-text match,
      // classification falls back to the generic legacy-name class instead.
      expect(classifyToolErrorClass(classified)).not.toBe('not_found');
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

    // ENG-1300: metaService.createCampaign's errors are FacebookRequestError
    // instances (SDK-shaped) — metaService.handleError rethrows the SDK error
    // unchanged (only attaching structuredError), so its own `.status` is the
    // real HTTP status. Prove it survives to `code` and classifies end-to-end,
    // distinct from a Meta business error code.
    it('ENG-1300: a 403 (error.status, SDK-shaped) classifies as auth/config end-to-end', async () => {
      const sdkError: any = new Error('Insufficient permission to perform this action');
      sdkError.status = 403;
      sdkError.structuredError = { code: 200, classification: 'PERMISSION_ERROR' };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.createCampaign as jest.Mock).mockRejectedValue(sdkError);

      const result = await agentModeService.createMetaAdsCampaign('user123', {
        name: 'Test Campaign', objective: 'OUTCOME_TRAFFIC',
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe(403);
      const classified = toolResultError(result);
      expect(classifyToolErrorClass(classified)).toBe('auth');
      expect(classifyToolFailureType(classifyToolErrorClass(classified))).toBe('config');
    });
  });

  describe('updateMetaAdsCampaign', () => {
    it('should successfully update a campaign', async () => {
      const campaignId = 'camp_123';
      const params = { name: 'Updated Campaign Name', status: 'ACTIVE' };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.updateCampaign as jest.Mock).mockResolvedValue({ success: true });
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: campaignId, ...params }); // ENG-3065 read-back

      const result = await agentModeService.updateMetaAdsCampaign('user123', campaignId, params);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign updated successfully');
      expect(metaService.updateCampaign).toHaveBeenCalledWith('mock-access-token', campaignId, params, '123456789');
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
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', name: 'Updated' }); // ENG-3065 read-back

      const result = await agentModeService.updateMetaAdsCampaign(
        'user123',
        'camp_123',
        { name: 'Updated' },
        '987654321'
      );

      expect(result.success).toBe(true);
      expect(metaService.updateCampaign).toHaveBeenCalledWith('token2', 'camp_123', { name: 'Updated' }, '987654321');
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
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: campaignId, status: 'DELETED' }); // ENG-3065 read-back

      const result = await agentModeService.deleteMetaAdsCampaign('user123', campaignId);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Campaign deleted successfully');
      expect(metaService.deleteCampaign).toHaveBeenCalledWith('mock-access-token', campaignId, '123456789');
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
      (metaService.getCampaign as jest.Mock).mockResolvedValue({ id: 'camp_123', status: 'DELETED' }); // ENG-3065 read-back

      const result = await agentModeService.deleteMetaAdsCampaign('user123', 'camp_123', '987654321');

      expect(result.success).toBe(true);
      expect(metaService.deleteCampaign).toHaveBeenCalledWith('token2', 'camp_123', '987654321');
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
