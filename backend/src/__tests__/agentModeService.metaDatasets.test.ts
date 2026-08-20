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

// ENG-926 §F — the empty-`event_stats` fallback reads our own coverage store. Mocked so this
// suite never reaches DynamoDB; the store's own behaviour is covered in
// metaCapiKeyCoverage.test.ts.
jest.mock('../services/metaCapiKeyCoverageDb', () => ({
  queryCapiKeyCoverageRows: jest.fn().mockResolvedValue([])
}));
import { queryCapiKeyCoverageRows } from '../services/metaCapiKeyCoverageDb';

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
      // Meta answered, so the send-side fallback must NOT engage — the real number wins.
      expect((result as any).send_side_identity_coverage).toBeUndefined();
      expect(queryCapiKeyCoverageRows).not.toHaveBeenCalled();
    });

    // ─── ENG-926 §F — the empty-event_stats fallback ────────────────────────────────
    //
    // `event_stats` is the only EMQ surface Meta exposes and on live busy pixels it returns
    // EMPTY (probed on two pixels, two tokens, two Business Managers). Before this, the tool
    // returned that verbatim — answering `{}` to every customer who asked Emma for match
    // quality, while the tool description advertised "EMQ scores per event type".
    //
    // ⚠ The pre-existing test above mocks event_stats NON-empty, so it exercises the
    // untouched path and proves nothing about this one. Hence these.

    // Each fixture is built by a FACTORY rather than by spreading a value, so the
    // "absent field" case can genuinely omit the key. `{ event_stats: undefined }` creates
    // an own property holding undefined, which is a different object shape from a missing
    // key — the test would have passed while modelling something it did not claim to.
    it.each([
      ['the JSON string Meta actually returns', () => ({ id: 'ds_100', name: 'My Dataset', event_stats: '{}' })],
      ['an empty object', () => ({ id: 'ds_100', name: 'My Dataset', event_stats: {} })],
      ['an absent field', () => ({ id: 'ds_100', name: 'My Dataset' })],
    ])('falls back to send-side coverage when event_stats is %s', async (_label, buildStats) => {
      const stats = buildStats();
      if (_label === 'an absent field') {
        // Pin the fixture itself: if a future edit reintroduces the key, this case silently
        // stops testing absence and starts retesting the undefined-value case above.
        expect(Object.prototype.hasOwnProperty.call(stats, 'event_stats')).toBe(false);
      }
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getDatasetEventStats as jest.Mock).mockResolvedValue(stats);

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        { dataset_id: 'ds_100' }
      );

      expect(result.success).toBe(true);
      expect((result as any).meta_event_match_quality_available).toBe(false);
      expect((result as any).send_side_identity_coverage).toBeDefined();
      // Scoped to the dataset asked about — a pixel is its own dataset in Graph v25.
      expect(queryCapiKeyCoverageRows).toHaveBeenCalledWith('ds_100', expect.any(String));
    });

    it('says plainly that the number is NOT Meta\'s score, so Emma cannot relay it as one', async () => {
      // The whole risk of answering with a substitute is that it gets repeated back to a
      // customer as Meta's own match quality. The wording is the mitigation, so it is pinned.
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getDatasetEventStats as jest.Mock).mockResolvedValue({
        id: 'ds_100', name: 'My Dataset', event_stats: '{}'
      });

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        { dataset_id: 'ds_100' }
      );

      expect(result.message).toContain('NOT');
      expect(result.message).toMatch(/send-side/i);
      expect(result.message).toMatch(/does not expose that number/i);
    });

    // ─── ENG-926 §F follow-up: Meta ERRORING is a second failure shape ──────────────
    //
    // The first fix handled "Meta returns empty". Live production showed the OTHER shape on a
    // real pixel: `getDatasetEventStats` THROWS, which escaped before the fallback could run,
    // so the tool still answered nothing. Handling only the documented shape is what made the
    // original fix partial.

    it('falls back to send-side coverage when the Meta call THROWS, not just when it is empty', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getDatasetEventStats as jest.Mock).mockRejectedValue(
        new Error('An unknown error has occurred.')
      );

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined, { dataset_id: 'ds_100' }
      );

      // ⚠ The verdict stays FAILURE. An existing test caught the first version of this
      // reporting success on a Meta error, which would have answered a question about a
      // dataset that may not even exist. The caller gets the coverage AND the truth.
      expect(result.success).toBe(false);
      expect((result as any).meta_event_match_quality_available).toBe(false);
      expect((result as any).send_side_identity_coverage).toBeDefined();
      expect(result.message).toContain('An unknown error has occurred.');
      expect(queryCapiKeyCoverageRows).toHaveBeenCalledWith('ds_100', expect.any(String));
    });

    it('distinguishes "Meta errored" from "Meta returned empty" — they are not the same fact', async () => {
      // Collapsing them would let a real outage read as "Meta has no data for you", which is
      // the could-not-ask/received-nothing conflation this whole area exists to prevent.
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      (metaService.getDatasetEventStats as jest.Mock).mockRejectedValue(new Error('boom'));
      const errored: any = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined, { dataset_id: 'ds_100' }
      );

      (metaService.getDatasetEventStats as jest.Mock).mockResolvedValue({
        id: 'ds_100', name: 'My Dataset', event_stats: '{}'
      });
      const empty: any = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined, { dataset_id: 'ds_100' }
      );

      expect(errored.meta_event_stats_status).toBe('error');
      expect(errored.success).toBe(false);
      expect(empty.meta_event_stats_status).toBe('empty');
      expect(empty.success).toBe(true);
      expect(errored.meta_event_stats_error).toContain('boom');
      // Both hand back coverage — the difference is the verdict, not the payload.
      expect(errored.send_side_identity_coverage).toBeDefined();
      expect(empty.send_side_identity_coverage).toBeDefined();
    });

    it('does NOT swallow a Meta AUTH error — a dead token must not read as "no data"', async () => {
      // The outer handler rethrows isMetaAuthError so the caller can prompt a re-auth. Falling
      // back here would convert "your token is dead" into a quiet, plausible-looking answer.
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      const authErr: any = new Error('Error validating access token');
      authErr.isMetaAuthError = true;
      (metaService.getDatasetEventStats as jest.Mock).mockRejectedValue(authErr);

      await expect(
        agentModeService.callMetaMarketingApi(
          'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
          undefined, undefined, undefined, { dataset_id: 'ds_100' }
        )
      ).rejects.toMatchObject({ isMetaAuthError: true });
      expect(queryCapiKeyCoverageRows).not.toHaveBeenCalled();
    });

    it('does NOT substitute when event_stats is merely unparseable — that is a read failure, not an empty result', async () => {
      // Failing the other way would present a parse failure as a measurement.
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (metaService.getDatasetEventStats as jest.Mock).mockResolvedValue({
        id: 'ds_100', name: 'My Dataset', event_stats: 'not json'
      });

      const result = await agentModeService.callMetaMarketingApi(
        'user123', 'DATASET', 'GET_MATCH_QUALITY', '123456789',
        undefined, undefined, undefined,
        { dataset_id: 'ds_100' }
      );

      expect((result as any).send_side_identity_coverage).toBeUndefined();
      expect(queryCapiKeyCoverageRows).not.toHaveBeenCalled();
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
