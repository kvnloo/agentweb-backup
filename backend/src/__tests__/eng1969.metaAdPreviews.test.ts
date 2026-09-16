jest.mock('../services/agentModeService', () => ({
  agentModeService: { callMetaMarketingApi: jest.fn() },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';
import axios from 'axios';
import { META_READ_CALL_TIMEOUT_MS, metaService } from '../services/metaService';
import '../emma/tools';

jest.mock('axios');

describe('ENG-1969 Meta ad previews', () => {
  const tool = emmaToolRegistry.getTool('call_meta_marketing_api');

  beforeEach(() => jest.clearAllMocks());

  it('exposes PREVIEW for ads and ad creatives', () => {
    expect(tool?.definition.inputSchema.properties.action.enum).toContain('PREVIEW');
    expect(tool?.definition.inputSchema.properties.params.properties.ad_format).toEqual(
      expect.objectContaining({ type: 'string' }),
    );
  });

  it('routes an ad preview request with its placement format', async () => {
    (agentModeService.callMetaMarketingApi as jest.Mock).mockResolvedValue({ success: true });

    await tool!.execute({
      entity_type: 'AD', action: 'PREVIEW', account_id: '123', ad_id: 'ad_1',
      params: { ad_format: 'DESKTOP_FEED_STANDARD' },
    }, { userId: 'user-1' });

    expect(agentModeService.callMetaMarketingApi).toHaveBeenCalledWith(
      'user-1', 'AD', 'PREVIEW', '123', undefined, undefined, 'ad_1',
      { ad_format: 'DESKTOP_FEED_STANDARD' }, undefined,
    );
  });

  it('routes a creative preview request with its creative id', async () => {
    (agentModeService.callMetaMarketingApi as jest.Mock).mockResolvedValue({ success: true });

    await tool!.execute({
      entity_type: 'AD_CREATIVE', action: 'PREVIEW', account_id: '123',
      params: { creative_id: 'creative_1', ad_format: 'INSTAGRAM_STORY' },
    }, { userId: 'user-1' });

    expect(agentModeService.callMetaMarketingApi).toHaveBeenCalledWith(
      'user-1', 'AD_CREATIVE', 'PREVIEW', '123', undefined, undefined, undefined,
      { creative_id: 'creative_1', ad_format: 'INSTAGRAM_STORY' }, undefined,
    );
  });

  it('documents that preview iframes expire after 24 hours', () => {
    expect(tool?.definition.description).toContain('24 hours');
  });

  it('bounds the Graph request and returns non-blank preview HTML', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { data: [{ body: '<iframe />' }] } });

    await expect(metaService.generateAdPreview('secret-token', 'ad_1', 'DESKTOP_FEED_STANDARD'))
      .resolves.toEqual([{ body: '<iframe />' }]);
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/ad_1/previews'),
      expect.objectContaining({
        params: { ad_format: 'DESKTOP_FEED_STANDARD', access_token: 'secret-token' },
        timeout: META_READ_CALL_TIMEOUT_MS,
        maxContentLength: 1_000_000,
      }),
    );
  });

  it.each([
    { rows: [] },
    { rows: [{ body: '' }] },
    { rows: [{ body: '   ' }] },
    { rows: [{ nope: true }] },
  ])(
    'rejects malformed or blank preview rows: %j',
    async ({ rows }) => {
      (axios.get as jest.Mock).mockResolvedValue({ data: { data: rows } });
      await expect(metaService.generateAdPreview('secret-token', 'ad_1', 'DESKTOP_FEED_STANDARD'))
        .rejects.toThrow('Meta returned an invalid ad preview response.');
    },
  );

  it('does not propagate the access token in request errors', async () => {
    const requestError: any = new Error('Meta request failed');
    requestError.config = { params: { access_token: 'secret-token' } };
    (axios.get as jest.Mock).mockRejectedValue(requestError);

    await expect(metaService.generateAdPreview('secret-token', 'ad_1', 'DESKTOP_FEED_STANDARD'))
      .rejects.not.toHaveProperty('config');
  });
});