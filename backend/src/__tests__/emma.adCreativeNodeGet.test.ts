/**
 * ENG-471 AC1 — Emma can GET a single ad creative node, including `asset_feed_spec`.
 *
 * The service half has existed all along: `metaService.getAdCreative` already
 * requests `asset_feed_spec` and is used on four internal call sites (COPY_AD,
 * RETAG_UTM). What was missing was purely the model-facing contract — `GET` was
 * absent from the tool's action enum and from `manageMetaAdsAdCreatives`, so
 * Emma could build a placement-customized creative and then had no way to read
 * it back.
 *
 * That blindness is why a creative swap cannot be verified in-product, and it is
 * the same shape as ENG-838 (a deployment applying default bid settings
 * undetectably). Both trace to the product being unable to read back what it wrote.
 *
 * Spies on the real modules rather than `jest.mock`-ing metaService wholesale:
 * agentModeService calls many of its statics, and replacing the module makes the
 * test fail for reasons unrelated to the behaviour under test. No live Graph API
 * call and no credentials are involved either way.
 */

import { agentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools';

/** A placement-customized creative: 1:1 Feed + 9:16 Story/Reels via asset_feed_spec. */
const PLACEMENT_CUSTOMIZED = {
  id: '120210000000000000',
  account_id: '922903076601160',
  name: 'ICP1 — placement customized',
  object_type: 'SHARE',
  asset_feed_spec: {
    images: [
      { hash: 'hash_1x1', adlabels: [{ name: 'feed' }] },
      { hash: 'hash_9x16', adlabels: [{ name: 'story' }] },
    ],
    asset_customization_rules: [
      {
        image_label: { name: 'feed' },
        customization_spec: { publisher_platforms: ['facebook'], facebook_positions: ['feed'] },
      },
      {
        image_label: { name: 'story' },
        customization_spec: { publisher_platforms: ['instagram'], instagram_positions: ['story'] },
      },
    ],
  },
  url_tags: 'utm_source=facebook&utm_medium=paid',
};

let getAdCreativeSpy: jest.SpyInstance;
let credentialsSpy: jest.SpyInstance;

beforeEach(() => {
  getAdCreativeSpy = jest
    .spyOn(metaService, 'getAdCreative')
    .mockResolvedValue(PLACEMENT_CUSTOMIZED as never);
  credentialsSpy = jest
    .spyOn(agentModeService as any, 'getMetaCredentials')
    .mockResolvedValue({ accountId: 'act_922903076601160', accessToken: 'test-token' } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ENG-471 AC1 — AD_CREATIVE GET is exposed to the model', () => {
  it('declares GET in the tool action enum', () => {
    const schema = emmaToolRegistry.getTool('call_meta_marketing_api')!
      .definition.inputSchema.properties.action;

    expect(schema.enum).toContain('GET');
  });

  it('advertises GET for AD_CREATIVE in the action matrix', () => {
    // The prose IS the contract the model reads. Adding the enum value without
    // advertising it leaves the capability discoverable only by accident —
    // which is this issue's own failure mode, one level up.
    const description = emmaToolRegistry.getTool('call_meta_marketing_api')!.definition.description;
    const matrixLine = description
      .split('\n')
      .find((l: string) => l.includes('AD_CREATIVE') && l.includes('→'));

    expect(matrixLine).toBeDefined();
    expect(matrixLine).toContain('GET');
  });

  it('returns the creative node including asset_feed_spec', async () => {
    const result: any = await agentModeService.manageMetaAdsAdCreatives(
      'user-1',
      'GET',
      'act_922903076601160',
      { creative_id: '120210000000000000' },
    );

    expect(result.success).toBe(true);
    expect(result.creative).toEqual(PLACEMENT_CUSTOMIZED);
    // The whole point: placement customization must survive the round trip, or
    // a faithful clone of a Feed + Story creative is impossible.
    expect(result.creative.asset_feed_spec.asset_customization_rules).toHaveLength(2);
    expect(result.creative.asset_feed_spec.images.map((i: any) => i.hash))
      .toEqual(['hash_1x1', 'hash_9x16']);
  });

  it('passes the requested creative id through to the Graph boundary', async () => {
    await agentModeService.manageMetaAdsAdCreatives(
      'user-1',
      'GET',
      'act_922903076601160',
      { creative_id: '120210000000000000' },
    );

    expect(getAdCreativeSpy).toHaveBeenCalledTimes(1);
    expect(getAdCreativeSpy.mock.calls[0][1]).toBe('120210000000000000');
    expect(credentialsSpy).toHaveBeenCalled();
  });

  it('fails loudly when creative_id is missing rather than reading something else', async () => {
    // Silently degrading a node-GET into an account-wide LIST would be worse
    // than the original gap: the model would believe it read one specific
    // creative and act on a different one.
    await expect(
      agentModeService.manageMetaAdsAdCreatives('user-1', 'GET', 'act_1', {}),
    ).rejects.toThrow(/creative_id/i);

    expect(getAdCreativeSpy).not.toHaveBeenCalled();
  });

  // A creative id addresses a node GLOBALLY, and one Meta OAuth token can reach
  // several ad accounts. So "the token worked" is not the same as "this creative
  // is in the account you selected". Without binding, selecting account A and
  // passing a creative id from account B returns B's object_story_spec,
  // url_tags and asset_feed_spec — a tenant boundary crossed by a read that
  // looks entirely successful.
  it('refuses a creative belonging to a different ad account', async () => {
    getAdCreativeSpy.mockResolvedValue({
      ...PLACEMENT_CUSTOMIZED,
      account_id: '111111111111111', // a different account the token can also reach
    } as never);

    await expect(
      agentModeService.manageMetaAdsAdCreatives(
        'user-1',
        'GET',
        'act_922903076601160',
        { creative_id: '120210000000000000' },
      ),
    ).rejects.toThrow(/belongs to ad account 111111111111111.*not the selected account/i);
  });

  it('accepts the creative when the account matches, with or without the act_ prefix', async () => {
    // The selected id arrives as `act_<n>` and Meta returns a bare `<n>`, so a
    // naive string compare would reject every legitimate read.
    getAdCreativeSpy.mockResolvedValue({
      ...PLACEMENT_CUSTOMIZED,
      account_id: '922903076601160',
    } as never);

    const result: any = await agentModeService.manageMetaAdsAdCreatives(
      'user-1',
      'GET',
      'act_922903076601160',
      { creative_id: '120210000000000000' },
    );

    expect(result.success).toBe(true);
  });

  it('fails closed when the creative does not say which account owns it', async () => {
    // account_id is requested explicitly, so its absence on an otherwise valid
    // node means the assumption behind the check no longer holds. Returning the
    // creative anyway would silently drop the boundary.
    getAdCreativeSpy.mockResolvedValue({
      id: '120210000000000000',
      name: 'no owner field',
    } as never);

    await expect(
      agentModeService.manageMetaAdsAdCreatives(
        'user-1',
        'GET',
        'act_922903076601160',
        { creative_id: '120210000000000000' },
      ),
    ).rejects.toThrow(/could not verify which ad account/i);
  });

  it('leaves LIST behaviour untouched', async () => {
    // LIST is account-wide and omits asset_feed_spec — that is why GET was
    // needed. Adding GET must not quietly change what LIST does.
    const listSpy = jest
      .spyOn(agentModeService as any, 'listMetaAdsAdCreatives')
      .mockResolvedValue({ success: true, creatives: [] } as never);

    await agentModeService.manageMetaAdsAdCreatives('user-1', 'LIST', 'act_1', {});

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(getAdCreativeSpy).not.toHaveBeenCalled();
  });
});
