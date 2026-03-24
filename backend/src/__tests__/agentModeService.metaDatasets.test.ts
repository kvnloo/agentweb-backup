// Mock MCP client service first
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/metaService', () => ({
  metaService: {
    listPixels: jest.fn(),
    listDatasets: jest.fn(),
    getDatasetEventStats: jest.fn()
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

describe('AgentModeService - Meta Datasets (Match Quality)', () => {
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

  describe('DATASET LIST', () => {
    it('should list pixels and their datasets', async () => {
      const mockPixels = [
        { id: 'pixel_001', name: 'My Pixel' },
        { id: 'pixel_002', name: 'Second Pixel' }
      ];
      const mockDatasets1 = [{ id: 'ds_100', name: 'Dataset A' }];
      const mockDatasets2 = [{ id: 'ds_200', name: 'Dataset B' }, { id: 'ds_201', name: 'Dataset C' }];

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue(mockPixels);
      (metaService.listDatasets as jest.Mock)
        .mockResolvedValueOnce(mockDatasets1)
        .mockResolvedValueOnce(mockDatasets2);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 pixel(s)');
      expect(result.message).toContain('3 dataset(s)');
      expect((result as any).pixels).toHaveLength(2);
      expect((result as any).pixels[0].pixel_id).toBe('pixel_001');
      expect((result as any).pixels[0].datasets).toEqual(mockDatasets1);
      expect((result as any).pixels[1].datasets).toEqual(mockDatasets2);
    });

    it('should handle no pixels found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('0 pixel(s)');
      expect((result as any).pixels).toEqual([]);
    });

    it('should handle pixels with no datasets', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([{ id: 'pixel_001', name: 'My Pixel' }]);
      (metaService.listDatasets as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('1 pixel(s)');
      expect(result.message).toContain('0 dataset(s)');
    });
  });

  describe('DATASET GET_MATCH_QUALITY', () => {
    it('should return event match quality stats for a dataset', async () => {
      const mockStats = {
        id: 'ds_100',
        name: 'My Dataset',
        event_stats: [
          { event: 'Purchase', count: 1500, emq_score: 8.2 },
          { event: 'Lead', count: 3200, emq_score: 6.5 }
        ]
      };

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getDatasetEventStats as jest.Mock).mockResolvedValue(mockStats);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        { dataset_id: 'ds_100' }
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('My Dataset');
      expect((result as any).dataset_id).toBe('ds_100');
      expect((result as any).event_stats).toEqual(mockStats.event_stats);
      expect(metaService.getDatasetEventStats).toHaveBeenCalledWith('ds_100', 'mock-access-token');
    });

    it('should fail validation when dataset_id is missing', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        {}
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('dataset_id');
    });

    it('should handle API errors gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getDatasetEventStats as jest.Mock).mockRejectedValue(
        new Error('Dataset not found or no CAPI data')
      );

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        { dataset_id: 'ds_invalid' }
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Dataset not found');
    });
  });

  describe('DATASET invalid action', () => {
    it('should reject unsupported actions', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'CREATE', '123456789'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid action');
    });
  });
});
