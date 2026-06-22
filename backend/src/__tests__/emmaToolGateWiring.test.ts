/**
 * Wiring test: the REAL emma tool execute handlers (emma/tools.ts) must map their
 * args into the gated service methods so the confirmation gate fires. This closes
 * the seam left by metaValidation/imageEditGate, which call the service methods
 * directly and bypass the tool handlers. Here we drive the actual registered tools.
 *
 * Composition: this proves "tool execute -> real gate -> awaitingUserConfirmation".
 * agentModeService.confirmationHalt.test.ts proves "awaitingUserConfirmation -> loop
 * halts". Together they cover the full path without spinning up the whole tool suite.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true),
    initialize: jest.fn(),
    discoverToolsForUser: jest.fn(),
    getTools: jest.fn().mockReturnValue([])
  }))
}));

// Keep the real MetaService class (static param validators run before the gate)
// while mocking the singleton's network methods.
jest.mock('../services/metaService', () => {
  const actual = jest.requireActual('../services/metaService');
  return {
    ...actual,
    metaService: {
      createAd: jest.fn(),
      createCampaign: jest.fn(),
      createAdCreative: jest.fn(),
      createCustomAudience: jest.fn(),
      getCampaign: jest.fn(),
      getAdSet: jest.fn(),
      getAd: jest.fn()
    }
  };
});

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      id: 'user123',
      connected_accounts: [{
        platform: 'meta',
        account_id: '123456789',
        account_name: 'Test Business',
        config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: '123456789' }
      }]
    })
  }
}));
jest.mock('../utils/secretsManager', () => ({ getMetaAccessToken: jest.fn().mockResolvedValue('tok') }));

import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools'; // side-effect: registers call_meta_marketing_api + generate_image
import { metaService } from '../services/metaService';

const ctx = { userId: 'user123', sessionId: 'sess1' } as any;

describe('emma tool handlers wire args into the confirmation gate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('call_meta_marketing_api: AD CREATE without confirm returns awaitingUserConfirmation and does not write', async () => {
    const result: any = await emmaToolRegistry.execute('call_meta_marketing_api', {
      entity_type: 'AD',
      action: 'CREATE',
      account_id: '123456789',
      ad_set_id: 'adset_1',
      params: { name: 'New Ad', creative_id: 'creative_1' }
    }, ctx);

    expect(result.awaitingUserConfirmation).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(metaService.createAd).not.toHaveBeenCalled();
  });

  it('call_meta_marketing_api: confirm=true (in params) bypasses the gate and writes', async () => {
    (metaService.createAd as jest.Mock).mockResolvedValue({ id: 'ad_new', name: 'New Ad' });

    const result: any = await emmaToolRegistry.execute('call_meta_marketing_api', {
      entity_type: 'AD',
      action: 'CREATE',
      account_id: '123456789',
      ad_set_id: 'adset_1',
      params: { name: 'New Ad', creative_id: 'creative_1', confirm: true }
    }, ctx);

    expect(result.awaitingUserConfirmation).toBeUndefined();
    expect(metaService.createAd).toHaveBeenCalledTimes(1);
  });

  it('generate_image: image EDIT (inputImages set) without confirm returns awaitingUserConfirmation', async () => {
    const result: any = await emmaToolRegistry.execute('generate_image', {
      prompt: 'sharpen it',
      filename: 'ad.png',
      imageModel: 'gemini-3-pro-image-preview', // avoids getImageApiDefaultModel lookup
      inputImages: ['https://cdn.example.com/a.png']
    }, ctx);

    expect(result.awaitingUserConfirmation).toBe(true);
    expect(result.confirmationPrompt).toContain('![source image 1](https://cdn.example.com/a.png)');
  });

  it('generate_image: image_model enum offers the GA id and no longer offers the preview id', () => {
    const def: any = emmaToolRegistry.getTool('generate_image')?.definition;
    const modelEnum: string[] = def?.inputSchema?.properties?.imageModel?.enum ?? [];
    expect(modelEnum).toContain('gemini-3.1-flash-image'); // GA id selectable
    expect(modelEnum).not.toContain('gemini-3.1-flash-image-preview'); // preview dropped from the menu
  });
});
