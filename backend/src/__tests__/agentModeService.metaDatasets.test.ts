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
    // ENG-399. Meta unified pixels and datasets in Graph v25: a pixel IS its own dataset,
    // and the per-pixel `/<pixel_id>/datasets` edge no longer exists. Calling it returns
    // `(#100) Tried accessing nonexisting field (datasets)`. Because metaService.handleError
    // THROWS, that single bad edge failed the whole LIST — making pixel discovery impossible
    // in-product. LIST now derives the dataset id from the pixel itself and never calls the
    // dead edge. Same conclusion already reached (and pinned) for the lander pixel resolver
    // in metaService.pixelResolution.test.ts.

    it('AC1: returns pixel id/name/last_fired_time and the unified dataset id, with no error', async () => {
      const mockPixels = [
        { id: 'pixel_001', name: 'My Pixel', last_fired_time: '2026-07-19T10:00:00+0000' },
        { id: 'pixel_002', name: 'Second Pixel', last_fired_time: '2026-07-18T09:30:00+0000' }
      ];

      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue(mockPixels);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('2 pixel(s)');

      const pixels = (result as any).pixels;
      expect(pixels).toHaveLength(2);

      expect(pixels[0].pixel_id).toBe('pixel_001');
      expect(pixels[0].pixel_name).toBe('My Pixel');
      expect(pixels[0].last_fired_time).toBe('2026-07-19T10:00:00+0000');
      // The pixel id IS the dataset id in v25 — this is what GET_MATCH_QUALITY consumes.
      expect(pixels[0].dataset_id).toBe('pixel_001');
      expect(pixels[0].datasets).toEqual([{ id: 'pixel_001', name: 'My Pixel' }]);

      expect(pixels[1].pixel_id).toBe('pixel_002');
      expect(pixels[1].dataset_id).toBe('pixel_002');
    });

    it('AC2: returns an empty list for an account with zero pixels, not an error', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('0 pixel(s)');
      expect((result as any).pixels).toEqual([]);
    });

    it('ENG-399 regression: never calls the dead per-pixel /datasets edge', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([
        { id: 'pixel_001', name: 'My Pixel' },
        { id: 'pixel_002', name: 'Second Pixel' }
      ]);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      // `listDatasets` is removed from metaService entirely; assert nothing resurrects the call.
      expect((metaService as any).listDatasets).not.toHaveBeenCalled();
      expect(metaService.listPixels).toHaveBeenCalledTimes(1);
    });

    it('ENG-399 production repro: LIST succeeds even though the /datasets edge throws Meta #100', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([{ id: 'pixel_001', name: 'My Pixel' }]);
      // Exactly what Graph v25 returns for the removed edge, and what metaService.handleError
      // rethrows. Before the fix this rejection propagated and failed the entire LIST.
      (metaService as any).listDatasets.mockRejectedValue(
        new Error('(#100) Tried accessing nonexisting field (datasets) on node type (AdsPixel)')
      );

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );

      expect(result.success).toBe(true);
      expect(result.message).not.toContain('nonexisting field');
      expect((result as any).pixels[0].dataset_id).toBe('pixel_001');
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

    it('AC3: accepts a dataset_id taken straight from the fixed LIST output', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.listPixels as jest.Mock).mockResolvedValue([
        { id: 'pixel_001', name: 'My Pixel', last_fired_time: '2026-07-19T10:00:00+0000' }
      ]);

      const listResult = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'LIST', '123456789'
      );
      const datasetId = (listResult as any).pixels[0].dataset_id;

      (metaService.getDatasetEventStats as jest.Mock).mockResolvedValue({
        id: datasetId,
        name: 'My Pixel',
        event_stats: [{ event: 'Lead', count: 42, emq_score: 7.1 }]
      });

      const emqResult = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        { dataset_id: datasetId }
      );

      expect(emqResult.success).toBe(true);
      expect((emqResult as any).dataset_id).toBe('pixel_001');
      expect(metaService.getDatasetEventStats).toHaveBeenCalledWith('pixel_001', 'mock-access-token');
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
