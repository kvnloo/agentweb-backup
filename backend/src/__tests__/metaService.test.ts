
import { MetaService } from '../services/metaService';
import { FacebookAdsApi, AdAccount, Campaign, AdSet, AdCreative, Ad, CustomAudience, User } from 'facebook-nodejs-business-sdk';

// Mock the facebook-nodejs-business-sdk
jest.mock('facebook-nodejs-business-sdk', () => {
    return {
        FacebookAdsApi: {
            init: jest.fn(),
        },
        AdAccount: jest.fn().mockImplementation(() => ({
            getCampaigns: jest.fn(),
            createCampaign: jest.fn(),
            getAdSets: jest.fn(),
            createAdSet: jest.fn(),
            getAdCreatives: jest.fn(),
            createAdCreative: jest.fn(),
            getAds: jest.fn(),
            createAd: jest.fn(),
            createAdImage: jest.fn(),
            createAdVideo: jest.fn(),
            getCustomAudiences: jest.fn(),
            createCustomAudience: jest.fn(),
            getTargetingSearch: jest.fn(),
            getInsights: jest.fn(),
        })),
        Campaign: jest.fn().mockImplementation(() => ({
            get: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        })),
        AdSet: jest.fn().mockImplementation(() => ({
            get: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        })),
        // AdCreative typically doesn't have update/delete in this service yet
        AdCreative: Object.assign(
            jest.fn().mockImplementation(() => ({
                get: jest.fn(),
            })),
            {
                Fields: {
                    name: 'name',
                    object_story_spec: 'object_story_spec',
                }
            }
        ),
        Ad: jest.fn().mockImplementation(() => ({
            update: jest.fn(),
            delete: jest.fn(),
        })),
        CustomAudience: jest.fn().mockImplementation(() => ({
            createUser: jest.fn(),
        })),
        User: jest.fn().mockImplementation(() => ({
            getAdAccounts: jest.fn(),
            getAccounts: jest.fn(),
            get: jest.fn(),
        })),
    };
});

jest.mock('../utils/secretsManager', () => ({
    getMetaCredentials: jest.fn(),
}));

// Mock static fields that are used in code
// @ts-ignore
AdSet.Fields = {
    name: 'name',
    campaign_id: 'campaign_id',
    billing_event: 'billing_event',
    optimization_goal: 'optimization_goal',
    targeting: 'targeting',
    status: 'status',
    daily_budget: 'daily_budget',
    lifetime_budget: 'lifetime_budget',
    bid_strategy: 'bid_strategy',
    bid_amount: 'bid_amount',
    start_time: 'start_time',
    end_time: 'end_time',
    promoted_object: 'promoted_object',
};

// @ts-ignore
Ad.Fields = {
    name: 'name',
    adset_id: 'adset_id',
    creative: 'creative',
    status: 'status',
};

// @ts-ignore
Ad.Status = {
    paused: 'PAUSED',
};

describe('MetaService', () => {
    let service: MetaService;
    const mockAccessToken = 'mock_access_token';
    const mockAdAccountId = '1234567890';

    beforeEach(() => {
        service = MetaService.getInstance();
        jest.clearAllMocks();
    });

    describe('Campaign Operations', () => {
        it('should get a single campaign', async () => {
             const mockCampaignData = { id: 'camp_1', name: 'Campaign 1' };
             const mockGet = jest.fn().mockResolvedValue({ _data: mockCampaignData });
             (Campaign as unknown as jest.Mock).mockImplementation(() => ({
                 get: mockGet,
             }));
 
             const result = await service.getCampaign(mockAdAccountId, mockAccessToken, 'camp_1');
 
             expect(Campaign).toHaveBeenCalledWith('camp_1');
             expect(mockGet).toHaveBeenCalled();
             expect(result).toEqual(mockCampaignData);
        });

        it('should list campaigns', async () => {
            const mockCampaigns = [{ _data: { id: 'camp_1', name: 'Campaign 1' } }];
            const mockGetCampaigns = jest.fn().mockResolvedValue(mockCampaigns);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getCampaigns: mockGetCampaigns,
            }));

            const result = await service.listCampaigns(mockAdAccountId, mockAccessToken);

            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockGetCampaigns).toHaveBeenCalled();
            expect(result).toEqual([{ id: 'camp_1', name: 'Campaign 1' }]);
        });

        it('should create a campaign', async () => {
            const mockCampaignData = { id: 'camp_new', name: 'New Campaign' };
            const mockCreateCampaign = jest.fn().mockResolvedValue({ _data: mockCampaignData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createCampaign: mockCreateCampaign,
            }));

            const params = {
                name: 'New Campaign',
                objective: 'OUTCOME_TRAFFIC',
                status: 'PAUSED',
                special_ad_categories: [],
            };

            const result = await service.createCampaign(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCampaign).toHaveBeenCalledWith(['id'], expect.objectContaining({
                name: 'New Campaign',
                objective: 'OUTCOME_TRAFFIC',
            }));
            expect(result).toEqual(mockCampaignData);
        });

        it('should update a campaign', async () => {
            const mockUpdate = jest.fn().mockResolvedValue({});
            (Campaign as unknown as jest.Mock).mockImplementation(() => ({
                update: mockUpdate,
            }));

            const campaignId = 'camp_123';
            const params = { name: 'Updated Campaign Name' };

            const result = await service.updateCampaign(mockAccessToken, campaignId, params);

            expect(Campaign).toHaveBeenCalledWith(campaignId);
            expect(mockUpdate).toHaveBeenCalledWith([], params);
            expect(result).toEqual({ success: true });
        });

        it('should delete a campaign', async () => {
            const mockDelete = jest.fn().mockResolvedValue({});
            (Campaign as unknown as jest.Mock).mockImplementation(() => ({
                delete: mockDelete,
            }));

            const campaignId = 'camp_123';

            const result = await service.deleteCampaign(mockAccessToken, campaignId);

            expect(Campaign).toHaveBeenCalledWith(campaignId);
            expect(mockDelete).toHaveBeenCalledWith([], {});
            expect(result).toEqual({ success: true });
        });
    });

    describe('Ad Set Operations', () => {
        it('should list ad sets', async () => {
            const mockAdSets = [{ _data: { id: 'adset_1', name: 'Ad Set 1' } }];
            const mockGetAdSets = jest.fn().mockResolvedValue(mockAdSets);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getAdSets: mockGetAdSets,
            }));

            const result = await service.listAdSets(mockAdAccountId, mockAccessToken);

            expect(mockGetAdSets).toHaveBeenCalled();
            expect(result).toEqual([{ id: 'adset_1', name: 'Ad Set 1' }]);
        });

        it('should create an ad set', async () => {
            const mockAdSetData = { id: 'adset_new', name: 'New Ad Set' };
            const mockCreateAdSet = jest.fn().mockResolvedValue({ _data: mockAdSetData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdSet: mockCreateAdSet,
            }));

            const params = {
                name: 'New Ad Set',
                campaign_id: 'camp_123',
                billing_event: 'IMPRESSIONS',
                optimization_goal: 'REACH',
                targeting: { geo_locations: { countries: ['US'] } },
                daily_budget: 1000,
                status: 'PAUSED',
            };

            const result = await service.createAdSet(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateAdSet).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'New Ad Set',
                campaign_id: 'camp_123',
            }));
            expect(result).toEqual(mockAdSetData);
        });

        it('forwards destination_type to the Meta payload when provided (ENG-415)', async () => {
            const mockCreateAdSet = jest.fn().mockResolvedValue({ _data: { id: 'adset_dt' } });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdSet: mockCreateAdSet,
            }));

            await service.createAdSet(mockAdAccountId, mockAccessToken, {
                name: 'AS',
                campaign_id: 'c1',
                billing_event: 'IMPRESSIONS',
                optimization_goal: 'OFFSITE_CONVERSIONS',
                targeting: { geo_locations: { countries: ['US'] } },
                daily_budget: 1000,
                destination_type: 'WEBSITE',
            });

            expect(mockCreateAdSet).toHaveBeenCalledWith([], expect.objectContaining({ destination_type: 'WEBSITE' }));
        });

        it('omits destination_type from the payload when not provided (ENG-415)', async () => {
            const mockCreateAdSet = jest.fn().mockResolvedValue({ _data: { id: 'adset_no_dt' } });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdSet: mockCreateAdSet,
            }));

            await service.createAdSet(mockAdAccountId, mockAccessToken, {
                name: 'AS',
                campaign_id: 'c1',
                billing_event: 'IMPRESSIONS',
                optimization_goal: 'REACH',
                targeting: { geo_locations: { countries: ['US'] } },
                daily_budget: 1000,
            });

            const payload = mockCreateAdSet.mock.calls[0][1];
            expect(payload).not.toHaveProperty('destination_type');
        });

        it('should update an ad set', async () => {
            const mockUpdate = jest.fn().mockResolvedValue({});
            (AdSet as unknown as jest.Mock).mockImplementation(() => ({
                update: mockUpdate,
            }));

            const adSetId = 'adset_123';
            const params = { daily_budget: 2000 };

            const result = await service.updateAdSet(mockAccessToken, adSetId, params);

            expect(AdSet).toHaveBeenCalledWith(adSetId);
            expect(mockUpdate).toHaveBeenCalledWith([], params);
            expect(result).toEqual({ success: true });
        });

        it('should delete an ad set', async () => {
            const mockDelete = jest.fn().mockResolvedValue({});
            (AdSet as unknown as jest.Mock).mockImplementation(() => ({
                delete: mockDelete,
            }));

            const adSetId = 'adset_123';

            const result = await service.deleteAdSet(mockAccessToken, adSetId);

            expect(AdSet).toHaveBeenCalledWith(adSetId);
            expect(mockDelete).toHaveBeenCalledWith([], {});
            expect(result).toEqual({ success: true });
        });
    });

    describe('Ad Creative Operations', () => {
        it('should list ad creatives', async () => {
            const mockCreatives = [{ _data: { id: 'creative_1', name: 'Creative 1' } }];
            const mockGetCreatives = jest.fn().mockResolvedValue(mockCreatives);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getAdCreatives: mockGetCreatives,
            }));

            const result = await service.listAdCreatives(mockAdAccountId, mockAccessToken);

            expect(mockGetCreatives).toHaveBeenCalled();
            expect(result).toEqual([{ id: 'creative_1', name: 'Creative 1' }]);
        });

        it('should create an ad creative', async () => {
            const mockCreativeData = { id: 'creative_new', name: 'New Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'New Creative',
                page_id: 'page_123',
                image_url: 'http://example.com/image.jpg',
                body: 'Ad Body',
                title: 'Ad Title',
                link_url: 'http://example.com',
                call_to_action_type: 'LEARN_MORE',
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCreative).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'New Creative',
                object_story_spec: expect.objectContaining({
                    page_id: 'page_123',
                    link_data: expect.objectContaining({
                        message: 'Ad Body',
                        link: 'http://example.com',
                    }),
                }),
            }));
            expect(result).toEqual(mockCreativeData);
        });

        it('should build asset_feed_spec for a placement-customized creative', async () => {
            const mockCreativeData = { id: 'creative_pc', name: 'Placement Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'Placement Creative',
                page_id: 'page_123',
                body: 'Ad Body',
                title: 'Ad Title',
                link_url: 'http://example.com',
                call_to_action_type: 'LEARN_MORE',
                placement_assets: [
                    { image_hash: 'square_hash', is_default: true },
                    { image_hash: 'vertical_hash', placements: ['story', 'reels'] },
                ],
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(result).toEqual(mockCreativeData);
            const callArgs = mockCreateCreative.mock.calls[0][1];

            // asset_feed_spec must carry both images (each tagged with an adlabel)
            expect(callArgs.asset_feed_spec.images).toEqual([
                { hash: 'square_hash', adlabels: [{ name: 'asset_0' }] },
                { hash: 'vertical_hash', adlabels: [{ name: 'asset_1' }] },
            ]);

            // Copy/link/format carry across to asset_feed_spec
            expect(callArgs.asset_feed_spec.bodies).toEqual([{ text: 'Ad Body' }]);
            expect(callArgs.asset_feed_spec.titles).toEqual([{ text: 'Ad Title' }]);
            expect(callArgs.asset_feed_spec.link_urls).toEqual([{ website_url: 'http://example.com' }]);
            expect(callArgs.asset_feed_spec.ad_formats).toEqual(['SINGLE_IMAGE']);
            expect(callArgs.asset_feed_spec.call_to_action_types).toEqual(['LEARN_MORE']);
            // Placement-customization creatives must be marked optimization_type=PLACEMENT
            expect(callArgs.asset_feed_spec.optimization_type).toBe('PLACEMENT');

            // The vertical asset is scoped to story + reels placements (FB + IG positions unioned)
            const rules = callArgs.asset_feed_spec.asset_customization_rules;
            const verticalRule = rules.find((r: any) => r.image_label.name === 'asset_1');
            expect(verticalRule.customization_spec.facebook_positions).toEqual(
                expect.arrayContaining(['story', 'facebook_reels'])
            );
            expect(verticalRule.customization_spec.instagram_positions).toEqual(
                expect.arrayContaining(['story', 'reels'])
            );
            // Scoped rules must NOT carry an is_default flag
            expect(verticalRule.customization_spec.is_default).toBeUndefined();
            // Rule shape per Meta docs: no `priority` field
            expect(verticalRule.priority).toBeUndefined();

            // The square asset is the fallback rule — an EMPTY customization_spec ({}), per Meta docs
            // (NOT { is_default: true }, which Meta rejects).
            const defaultRule = rules.find((r: any) => r.image_label.name === 'asset_0');
            expect(defaultRule.customization_spec).toEqual({});

            // object_story_spec carries only the Page; all copy/link lives in asset_feed_spec
            expect(callArgs.object_story_spec.page_id).toBe('page_123');
            expect(callArgs.object_story_spec.link_data).toBeUndefined();
        });

        describe('getAdCreative', () => {
            // Meta's Graph API only returns the subfields of object_story_spec that are
            // explicitly requested via field-expansion syntax (e.g. "object_story_spec{link_data{image_hash}}").
            // Requesting the bare "object_story_spec" field omits image_hash and returns only the
            // hosted "picture" URL, even for creatives that were created from an image_hash.
            // COPY_AD relies on getAdCreative to read back image_hash so it can reuse the same
            // account-scoped hash on the copy; if the hash isn't requested, COPY_AD instead
            // re-uploads Meta's low-res preview "picture" URL, which Meta's own AdCreative
            // create endpoint rejects (error code 100, subcode 1487390).
            it('requests link_data.image_hash as an explicit subfield of object_story_spec', async () => {
                const mockGet = jest.fn().mockResolvedValue({ _data: { id: 'creative_1' } });
                (AdCreative as unknown as jest.Mock).mockImplementation(() => ({ get: mockGet }));

                await service.getAdCreative(mockAccessToken, 'creative_1');

                expect(mockGet).toHaveBeenCalled();
                const fields: string[] = mockGet.mock.calls[0][0];
                const objectStorySpecField = fields.find(f => f.startsWith('object_story_spec'));
                expect(objectStorySpecField).toBeDefined();
                expect(objectStorySpecField).toContain('link_data');
                expect(objectStorySpecField).toContain('image_hash');
            });

            it('requests video_data.image_hash as an explicit subfield of object_story_spec', async () => {
                const mockGet = jest.fn().mockResolvedValue({ _data: { id: 'creative_2' } });
                (AdCreative as unknown as jest.Mock).mockImplementation(() => ({ get: mockGet }));

                await service.getAdCreative(mockAccessToken, 'creative_2');

                const fields: string[] = mockGet.mock.calls[0][0];
                const objectStorySpecField = fields.find(f => f.startsWith('object_story_spec'));
                expect(objectStorySpecField).toContain('video_data');
                expect((objectStorySpecField ?? '').match(/image_hash/g)?.length).toBeGreaterThanOrEqual(2);
            });

            it('requests child_attachments.image_hash for carousel creatives', async () => {
                const mockGet = jest.fn().mockResolvedValue({ _data: { id: 'creative_3' } });
                (AdCreative as unknown as jest.Mock).mockImplementation(() => ({ get: mockGet }));

                await service.getAdCreative(mockAccessToken, 'creative_3');

                const fields: string[] = mockGet.mock.calls[0][0];
                const objectStorySpecField = fields.find(f => f.startsWith('object_story_spec'));
                expect(objectStorySpecField).toContain('child_attachments');
            });

            it('returns the raw creative data from the Graph API response', async () => {
                const mockCreativeData = {
                    id: 'creative_4',
                    object_story_spec: { link_data: { image_hash: 'abc123', link: 'https://example.com' } }
                };
                const mockGet = jest.fn().mockResolvedValue({ _data: mockCreativeData });
                (AdCreative as unknown as jest.Mock).mockImplementation(() => ({ get: mockGet }));

                const result = await service.getAdCreative(mockAccessToken, 'creative_4');

                expect(result).toEqual(mockCreativeData);
            });
        });
    });

    describe('Ad Operations', () => {
        it('should list ads with all non-deleted effective_status values', async () => {
            const mockAds = [{ _data: { id: 'ad_1', name: 'Ad 1', effective_status: 'ACTIVE' } }];
            const mockGetAds = jest.fn().mockResolvedValue(mockAds);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getAds: mockGetAds,
            }));

            const result = await service.listAds(mockAdAccountId, mockAccessToken);

            expect(mockGetAds).toHaveBeenCalledWith(
                expect.arrayContaining(['effective_status']),
                expect.objectContaining({
                    effective_status: expect.arrayContaining(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'])
                })
            );
            expect(result).toEqual([{ id: 'ad_1', name: 'Ad 1', effective_status: 'ACTIVE' }]);
        });

        it('should include CAMPAIGN_PAUSED and ADSET_PAUSED ads when listing', async () => {
            const mockAds = [
                { _data: { id: 'ad_1', name: 'Active Ad', effective_status: 'ACTIVE' } },
                { _data: { id: 'ad_2', name: 'Campaign Paused Ad', effective_status: 'CAMPAIGN_PAUSED' } },
                { _data: { id: 'ad_3', name: 'Adset Paused Ad', effective_status: 'ADSET_PAUSED' } },
            ];
            const mockGetAds = jest.fn().mockResolvedValue(mockAds);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getAds: mockGetAds,
            }));

            const result = await service.listAds(mockAdAccountId, mockAccessToken);

            expect(result).toHaveLength(3);
            expect(result.map((a: any) => a.effective_status)).toEqual(
                expect.arrayContaining(['ACTIVE', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'])
            );
        });

        it('should filter by adset_id when provided', async () => {
            const mockAds = [{ _data: { id: 'ad_1', name: 'Ad 1', effective_status: 'PAUSED' } }];
            const mockGetAds = jest.fn().mockResolvedValue(mockAds);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getAds: mockGetAds,
            }));

            await service.listAds(mockAdAccountId, mockAccessToken, 'adset_999');

            expect(mockGetAds).toHaveBeenCalledWith(
                expect.any(Array),
                expect.objectContaining({ adset_id: 'adset_999' })
            );
        });

        it('should create an ad', async () => {
            const mockAdData = { id: 'ad_new', name: 'New Ad' };
            const mockCreateAd = jest.fn().mockResolvedValue({ _data: mockAdData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAd: mockCreateAd,
            }));

            const params = {
                name: 'New Ad',
                adset_id: 'adset_123',
                creative_id: 'creative_123',
                status: 'PAUSED',
            };

            const result = await service.createAd(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateAd).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'New Ad',
                adset_id: 'adset_123',
                creative: expect.objectContaining({ creative_id: 'creative_123' }),
            }));
            expect(result).toEqual(mockAdData);
        });

        it('should update an ad', async () => {
            const mockUpdate = jest.fn().mockResolvedValue({});
            (Ad as unknown as jest.Mock).mockImplementation(() => ({
                update: mockUpdate,
            }));

            const adId = 'ad_123';
            const params = { name: 'Updated Ad Name' };

            const result = await service.updateAd(mockAccessToken, adId, params);

            expect(Ad).toHaveBeenCalledWith(adId);
            expect(mockUpdate).toHaveBeenCalledWith([], params);
            expect(result).toEqual({ success: true });
        });

        it('should delete an ad', async () => {
            const mockDelete = jest.fn().mockResolvedValue({});
            (Ad as unknown as jest.Mock).mockImplementation(() => ({
                delete: mockDelete,
            }));

            const adId = 'ad_123';

            const result = await service.deleteAd(mockAccessToken, adId);

            expect(Ad).toHaveBeenCalledWith(adId);
            expect(mockDelete).toHaveBeenCalledWith([], {});
            expect(result).toEqual({ success: true });
        });
    });

    describe('Upload Operations', () => {
        it('should upload an image and unwrap Meta\'s filename-keyed images map', async () => {
            // Meta's /adimages endpoint returns the result keyed by the uploaded filename.
            const filename = 'test-image.jpg';
            const mockImageData = {
                images: {
                    [filename]: { hash: 'image_hash_123', url: 'https://scontent.example/img.jpg' },
                },
            };
            const mockCreateAdImage = jest.fn().mockResolvedValue({ _data: mockImageData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdImage: mockCreateAdImage,
            }));

            const fileBuffer = Buffer.from('test image data');

            const result = await service.uploadImage(mockAdAccountId, mockAccessToken, filename, fileBuffer);

            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockCreateAdImage).toHaveBeenCalledWith([], {
                filename: filename,
                bytes: fileBuffer.toString('base64'),
            });
            // The flat { hash, url } entry must be unwrapped from the images map.
            expect(result).toEqual({ hash: 'image_hash_123', url: 'https://scontent.example/img.jpg' });
        });

        it('should return distinct hashes for distinct images keyed by different filenames', async () => {
            const calls = [
                { filename: 'creative-A.png', hash: 'hash_A' },
                { filename: 'creative-B.png', hash: 'hash_B' },
            ];
            const mockCreateAdImage = jest.fn()
                .mockResolvedValueOnce({ _data: { images: { 'creative-A.png': { hash: 'hash_A' } } } })
                .mockResolvedValueOnce({ _data: { images: { 'creative-B.png': { hash: 'hash_B' } } } });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdImage: mockCreateAdImage,
            }));

            const buf = Buffer.from('x');
            const results = [];
            for (const c of calls) {
                results.push(await service.uploadImage(mockAdAccountId, mockAccessToken, c.filename, buf));
            }

            expect(results[0]).toEqual({ hash: 'hash_A' });
            expect(results[1]).toEqual({ hash: 'hash_B' });
        });

        it('should fall back to flat _data when no images map is present', async () => {
            const mockCreateAdImage = jest.fn().mockResolvedValue({ _data: { hash: 'flat_hash' } });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdImage: mockCreateAdImage,
            }));

            const result = await service.uploadImage(mockAdAccountId, mockAccessToken, 'f.jpg', Buffer.from('x'));

            expect(result).toEqual({ hash: 'flat_hash' });
        });

        it('should upload a video', async () => {
            const mockVideoData = { id: 'video_123' };
            const mockCreateAdVideo = jest.fn().mockResolvedValue({ _data: mockVideoData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdVideo: mockCreateAdVideo,
            }));

            const videoUrl = 'https://example.com/video.mp4';

            const result = await service.uploadVideo(mockAdAccountId, mockAccessToken, videoUrl);

            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockCreateAdVideo).toHaveBeenCalledWith([], {
                file_url: videoUrl,
            });
            expect(result).toEqual(mockVideoData);
        });
    });

    describe('Custom Audience Operations', () => {
        it('should list custom audiences', async () => {
            const mockAudiences = [
                { _data: { id: 'audience_1', name: 'Audience 1', subtype: 'CUSTOM' } },
                { _data: { id: 'audience_2', name: 'Audience 2', subtype: 'LOOKALIKE' } }
            ];
            const mockGetCustomAudiences = jest.fn().mockResolvedValue(mockAudiences);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getCustomAudiences: mockGetCustomAudiences,
            }));

            const result = await service.listCustomAudiences(mockAdAccountId, mockAccessToken);

            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockGetCustomAudiences).toHaveBeenCalledWith(
                expect.arrayContaining(['id', 'name', 'description']),
                { limit: 50 }
            );
            expect(result).toEqual([
                { id: 'audience_1', name: 'Audience 1', subtype: 'CUSTOM' },
                { id: 'audience_2', name: 'Audience 2', subtype: 'LOOKALIKE' }
            ]);
        });

        it('should create a custom audience with CUSTOM subtype', async () => {
            const mockAudienceData = { id: 'audience_new', name: 'My Custom Audience' };
            const mockCreateCustomAudience = jest.fn().mockResolvedValue({ _data: mockAudienceData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createCustomAudience: mockCreateCustomAudience,
            }));

            const params = {
                name: 'My Custom Audience',
                subtype: 'CUSTOM',
                description: 'Test audience',
                customer_file_source: 'USER_PROVIDED_ONLY',
            };

            const result = await service.createCustomAudience(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCustomAudience).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'My Custom Audience',
                subtype: 'CUSTOM',
                customer_file_source: 'USER_PROVIDED_ONLY',
            }));
            expect(result).toEqual(mockAudienceData);
        });

        // ENG-600 live-test finding: Meta's current (v25) create API rejects
        // lookalike_spec.origin entirely — "(#2654) ... No custom_audience ID
        // given for lookalike cluster" — even with a well-formed
        // {id, type: 'custom_audience'} entry. Per Meta's Lookalike Audiences
        // guide, the seed is supplied via a separate top-level
        // origin_audience_id param; lookalike_spec itself only carries
        // type/country/ratio (origin only ever appears in READ responses).
        it('translates lookalike_spec.origin into a top-level origin_audience_id (Meta v25 create shape)', async () => {
            const mockAudienceData = { id: 'audience_lookalike', name: 'Lookalike Audience' };
            const mockCreateCustomAudience = jest.fn().mockResolvedValue({ _data: mockAudienceData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createCustomAudience: mockCreateCustomAudience,
            }));

            const params = {
                name: 'Lookalike Audience',
                subtype: 'LOOKALIKE',
                description: 'Lookalike test',
                lookalike_spec: {
                    ratio: 0.01,
                    origin: [{ id: 'source_audience_123', type: 'custom_audience' }],
                    country: 'US'
                },
            };

            const result = await service.createCustomAudience(mockAdAccountId, mockAccessToken, params);

            const [, calledParams] = mockCreateCustomAudience.mock.calls[0];
            expect(calledParams.origin_audience_id).toBe('source_audience_123');
            expect(calledParams.lookalike_spec.origin).toBeUndefined();
            expect(calledParams.lookalike_spec).toEqual(expect.objectContaining({
                type: 'similarity',
                ratio: 0.01,
                country: 'US',
            }));
            expect(result).toEqual(mockAudienceData);
        });
    });

    describe('Targeting Operations', () => {
        it('should search targeting options', async () => {
            const mockResults = [
                { _data: { id: '123', name: 'Marketing', type: 'adinterest' } },
                { _data: { id: '456', name: 'Technology', type: 'adinterest' } }
            ];
            const mockGetTargetingSearch = jest.fn().mockResolvedValue(mockResults);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getTargetingSearch: mockGetTargetingSearch,
            }));

            const query = 'marketing';
            const type = 'adinterest';

            const result = await service.searchTargeting(mockAdAccountId, mockAccessToken, query, type);

            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockGetTargetingSearch).toHaveBeenCalledWith([], {
                q: query,
                type: type,
            });
            expect(result).toEqual([
                { id: '123', name: 'Marketing', type: 'adinterest' },
                { id: '456', name: 'Technology', type: 'adinterest' }
            ]);
        });

        it('should search targeting with class parameter for behaviors', async () => {
            const mockResults = [
                { _data: { id: '789', name: 'Frequent Travelers', type: 'behaviors' } }
            ];
            const mockGetTargetingSearch = jest.fn().mockResolvedValue(mockResults);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getTargetingSearch: mockGetTargetingSearch,
            }));

            const query = 'travel';
            const type = 'behaviors';

            const result = await service.searchTargeting(mockAdAccountId, mockAccessToken, query, type);

            expect(mockGetTargetingSearch).toHaveBeenCalledWith([], {
                q: query,
                type: type,
                class: type,
            });
            expect(result).toEqual([
                { id: '789', name: 'Frequent Travelers', type: 'behaviors' }
            ]);
        });

        describe('geolocation search routing', () => {
            let mockFetch: jest.SpyInstance;

            beforeEach(() => {
                mockFetch = jest.spyOn(global, 'fetch');
            });

            afterEach(() => {
                mockFetch.mockRestore();
            });

            it('should route adgeolocation searches to the /search endpoint, not targetingsearch', async () => {
                const mockGeoResults = [
                    { key: '2418779', name: 'Palo Alto', type: 'city', region: 'California', region_id: 3847, country_code: 'US' }
                ];
                mockFetch.mockResolvedValue({
                    ok: true,
                    json: jest.fn().mockResolvedValue({ data: mockGeoResults })
                });
                const mockGetTargetingSearch = jest.fn();
                (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                    getTargetingSearch: mockGetTargetingSearch,
                }));

                const result = await service.searchTargeting(mockAdAccountId, mockAccessToken, 'Palo Alto', 'adgeolocation');

                // Must NOT go through the interest-oriented targetingsearch edge
                expect(mockGetTargetingSearch).not.toHaveBeenCalled();
                // Must hit the top-level /search endpoint with the geo type
                expect(mockFetch).toHaveBeenCalledWith(
                    expect.stringMatching(/\/search\?type=adgeolocation/)
                );
                expect(mockFetch).toHaveBeenCalledWith(
                    expect.stringContaining('q=Palo%20Alto')
                );
                expect(result).toEqual(mockGeoResults);
            });

            it('should pass location_types through for adgeolocation searches', async () => {
                mockFetch.mockResolvedValue({
                    ok: true,
                    json: jest.fn().mockResolvedValue({ data: [] })
                });
                (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                    getTargetingSearch: jest.fn(),
                }));

                await service.searchTargeting(mockAdAccountId, mockAccessToken, 'San Jose', 'adgeolocation', ['city']);

                expect(mockFetch).toHaveBeenCalledWith(
                    expect.stringContaining(`location_types=${encodeURIComponent(JSON.stringify(['city']))}`)
                );
            });

            it('should throw when the /search endpoint returns an error for geolocation', async () => {
                mockFetch.mockResolvedValue({
                    ok: true,
                    json: jest.fn().mockResolvedValue({ error: { message: 'Invalid location_types' } })
                });
                (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                    getTargetingSearch: jest.fn(),
                }));

                await expect(
                    service.searchTargeting(mockAdAccountId, mockAccessToken, 'Nowhere', 'adgeolocation')
                ).rejects.toThrow('Invalid location_types');
            });
        });
    });

    describe('Insights Operations', () => {
        it('should get insights with default timeframe (7 days) and level (campaign)', async () => {
            const mockInsights = [
                { _data: { campaign_id: '123', impressions: 10000, clicks: 500, spend: 100 } }
            ];
            const mockGetInsights = jest.fn().mockResolvedValue(mockInsights);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getInsights: mockGetInsights,
            }));

            const params = { timeframe: '7d' };
            const result = await service.getInsights(mockAdAccountId, mockAccessToken, params);

            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockGetInsights).toHaveBeenCalledWith(
                expect.arrayContaining(['impressions', 'clicks', 'spend', 'campaign_id', 'campaign_name']),
                expect.objectContaining({
                    level: 'campaign',
                    time_range: expect.objectContaining({
                        since: expect.any(String),
                        until: expect.any(String),
                    }),
                })
            );
            expect(result).toEqual([
                { campaign_id: '123', impressions: 10000, clicks: 500, spend: 100 }
            ]);
        });

        it('should get insights with 30 days timeframe', async () => {
            const mockInsights = [
                { _data: { campaign_id: '456', impressions: 50000, clicks: 2500, spend: 500 } }
            ];
            const mockGetInsights = jest.fn().mockResolvedValue(mockInsights);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getInsights: mockGetInsights,
            }));

            const params = { timeframe: '30d' };
            await service.getInsights(mockAdAccountId, mockAccessToken, params);

            expect(mockGetInsights).toHaveBeenCalledWith(
                expect.any(Array),
                expect.objectContaining({
                    level: 'campaign',
                })
            );
        });

        it('should get insights at adset level', async () => {
            const mockInsights = [
                { _data: { adset_id: '789', campaign_id: '123', impressions: 5000 } }
            ];
            const mockGetInsights = jest.fn().mockResolvedValue(mockInsights);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getInsights: mockGetInsights,
            }));

            const params = { timeframe: '7d', level: 'adset' };
            const result = await service.getInsights(mockAdAccountId, mockAccessToken, params);

            expect(mockGetInsights).toHaveBeenCalledWith(
                expect.arrayContaining(['adset_id', 'adset_name', 'campaign_id', 'campaign_name']),
                expect.objectContaining({
                    level: 'adset',
                })
            );
            expect(result).toEqual([
                { adset_id: '789', campaign_id: '123', impressions: 5000 }
            ]);
        });

        it('should get insights at ad level', async () => {
            const mockInsights = [
                { _data: { ad_id: '999', adset_id: '789', campaign_id: '123', clicks: 100 } }
            ];
            const mockGetInsights = jest.fn().mockResolvedValue(mockInsights);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getInsights: mockGetInsights,
            }));

            const params = { timeframe: '14d', level: 'ad' };
            const result = await service.getInsights(mockAdAccountId, mockAccessToken, params);

            expect(mockGetInsights).toHaveBeenCalledWith(
                expect.arrayContaining(['ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name']),
                expect.objectContaining({
                    level: 'ad',
                })
            );
            expect(result).toEqual([
                { ad_id: '999', adset_id: '789', campaign_id: '123', clicks: 100 }
            ]);
        });
    });

    describe('Meta Account Operations', () => {
        it('should get ad accounts', async () => {
            const mockAdAccounts = [
                {
                    id: 'act_123',
                    name: 'Test Account',
                    account_id: '123',
                    currency: 'USD',
                    account_status: 1,
                }
            ];
            const mockGetAdAccounts = jest.fn().mockResolvedValue(mockAdAccounts);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAdAccounts: mockGetAdAccounts,
            }));

            const result = await service.getAdAccounts(mockAccessToken);

            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(User).toHaveBeenCalledWith('me');
            expect(mockGetAdAccounts).toHaveBeenCalledWith(
                expect.arrayContaining(['id', 'name', 'account_id', 'currency', 'account_status'])
            );
            expect(result).toEqual(mockAdAccounts);
        });

        it('must not request the owner or business fields (Meta silently omits non-owned ad accounts when owner is requested)', async () => {
            const mockGetAdAccounts = jest.fn().mockResolvedValue([]);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAdAccounts: mockGetAdAccounts,
            }));

            await service.getAdAccounts(mockAccessToken);

            const requestedFields = mockGetAdAccounts.mock.calls[0][0];
            expect(requestedFields).not.toContain('owner');
            expect(requestedFields).not.toContain('business');
        });

        it('should include ad accounts without a business object (Business Manager accounts)', async () => {
            const mockAdAccounts = [
                {
                    id: 'act_123',
                    name: 'Business Account',
                    account_id: '123',
                    currency: 'USD',
                    account_status: 1,
                    owner: 'user123',
                    business: { id: 'biz123', name: 'Test Business' }
                },
                {
                    id: 'act_456',
                    name: 'Business Manager Account',
                    account_id: '456',
                    currency: 'USD',
                    account_status: 1,
                    owner: 'user123',
                    business: null  // Business Manager accounts may have business: null
                }
            ];
            const mockGetAdAccounts = jest.fn().mockResolvedValue(mockAdAccounts);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAdAccounts: mockGetAdAccounts,
            }));

            const result = await service.getAdAccounts(mockAccessToken);

            // Both accounts should be included — business: null is valid for Business Manager accounts
            expect(result).toHaveLength(2);
            expect(result[0].account_id).toBe('123');
            expect(result[1].account_id).toBe('456');
        });

        it('should filter out entries without an account_id', async () => {
            const mockAdAccounts = [
                {
                    id: 'act_123',
                    name: 'Valid Account',
                    account_id: '123',
                    currency: 'USD',
                    account_status: 1,
                    owner: 'user123',
                    business: null
                },
                {
                    id: 'act_456',
                    name: 'Invalid Entry',
                    account_id: undefined,  // No account_id — should be excluded
                    currency: 'USD',
                    account_status: 1,
                    owner: 'user123',
                    business: null
                }
            ];
            const mockGetAdAccounts = jest.fn().mockResolvedValue(mockAdAccounts);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAdAccounts: mockGetAdAccounts,
            }));

            const result = await service.getAdAccounts(mockAccessToken);

            expect(result).toHaveLength(1);
            expect(result[0].account_id).toBe('123');
        });

        describe('getPages granular fallback (when /me/accounts is empty)', () => {
            // Meta quirk: tokens whose page access comes via Business Manager task
            // assignment (Facebook Login for Business) return [] from /me/accounts even
            // though debug_token granular_scopes lists the opted-in pages. The fallback
            // enumerates those page IDs and reads each page directly.
            const { getMetaCredentials } = require('../utils/secretsManager');
            const realFetch = global.fetch;

            afterEach(() => {
                global.fetch = realFetch;
            });

            const mockFetchByUrl = (routes: Array<[string, any]>) => {
                global.fetch = jest.fn().mockImplementation((url: string) => {
                    const match = routes.find(([frag]) => String(url).includes(frag));
                    return Promise.resolve({ json: () => Promise.resolve(match ? match[1] : {}) });
                }) as any;
            };

            it('returns pages from granular scopes when /me/accounts is empty', async () => {
                (User as unknown as jest.Mock).mockImplementation(() => ({
                    getAccounts: jest.fn().mockResolvedValue([]),
                }));
                (getMetaCredentials as jest.Mock).mockResolvedValue({
                    clientId: 'app_id', clientSecret: 'app_secret',
                    instagramClientId: 'x', instagramClientSecret: 'y',
                });
                mockFetchByUrl([
                    ['debug_token', { data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: ['p1', 'p2'] }] } }],
                    ['/p1?', { id: 'p1', name: 'Page One', access_token: 'p1_token', category: 'Brand' }],
                    ['/p2?', { id: 'p2', name: 'Page Two', access_token: 'p2_token', category: 'Agency' }],
                ]);

                const result = await service.getPages('user_token');

                expect(result).toHaveLength(2);
                expect(result[0]).toEqual(expect.objectContaining({ id: 'p1', name: 'Page One', access_token: 'p1_token', category: 'Brand' }));
                expect(result[1]).toEqual(expect.objectContaining({ id: 'p2', name: 'Page Two', access_token: 'p2_token', category: 'Agency' }));
            });

            it('skips pages that error during direct read', async () => {
                (User as unknown as jest.Mock).mockImplementation(() => ({
                    getAccounts: jest.fn().mockResolvedValue([]),
                }));
                (getMetaCredentials as jest.Mock).mockResolvedValue({
                    clientId: 'app_id', clientSecret: 'app_secret',
                    instagramClientId: 'x', instagramClientSecret: 'y',
                });
                mockFetchByUrl([
                    ['debug_token', { data: { granular_scopes: [{ scope: 'pages_show_list', target_ids: ['p1', 'p2'] }] } }],
                    ['/p1?', { error: { message: 'missing permission', code: 100 } }],
                    ['/p2?', { id: 'p2', name: 'Page Two', access_token: 'p2_token', category: 'Agency' }],
                ]);

                const result = await service.getPages('user_token');

                expect(result).toHaveLength(1);
                expect(result[0].id).toBe('p2');
            });

            it('returns empty array when granular scopes have no page ids', async () => {
                (User as unknown as jest.Mock).mockImplementation(() => ({
                    getAccounts: jest.fn().mockResolvedValue([]),
                }));
                (getMetaCredentials as jest.Mock).mockResolvedValue({
                    clientId: 'app_id', clientSecret: 'app_secret',
                    instagramClientId: 'x', instagramClientSecret: 'y',
                });
                mockFetchByUrl([
                    ['debug_token', { data: { granular_scopes: [{ scope: 'ads_read' }] } }],
                ]);

                const result = await service.getPages('user_token');
                expect(result).toEqual([]);
            });

            it('returns empty array when credentials lookup fails (fallback is best-effort)', async () => {
                (User as unknown as jest.Mock).mockImplementation(() => ({
                    getAccounts: jest.fn().mockResolvedValue([]),
                }));
                (getMetaCredentials as jest.Mock).mockRejectedValue(new Error('no secret'));

                const result = await service.getPages('user_token');
                expect(result).toEqual([]);
            });

            it('does not invoke fallback when /me/accounts returns pages', async () => {
                (User as unknown as jest.Mock).mockImplementation(() => ({
                    getAccounts: jest.fn().mockResolvedValue([
                        { id: 'page_123', name: 'Direct Page', access_token: 't', category: 'Brand', tasks: [] }
                    ]),
                }));
                const fetchSpy = jest.fn();
                global.fetch = fetchSpy as any;

                const result = await service.getPages('user_token');

                expect(result).toHaveLength(1);
                expect(fetchSpy).not.toHaveBeenCalled();
            });
        });

        it('should get pages', async () => {
            const mockPages = [
                {
                    id: 'page_123',
                    _data: {
                        id: 'page_123',
                        name: 'Test Page',
                        access_token: 'page_token_123',
                        category: 'Business',
                        tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT']
                    }
                }
            ];
            const mockGetAccounts = jest.fn().mockResolvedValue(mockPages);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAccounts: mockGetAccounts,
            }));

            const result = await service.getPages(mockAccessToken);

            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(User).toHaveBeenCalledWith('me');
            expect(mockGetAccounts).toHaveBeenCalledWith(
                expect.arrayContaining(['id', 'name', 'access_token', 'category', 'tasks'])
            );
            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                id: 'page_123',
                name: 'Test Page',
                access_token: 'page_token_123',
                category: 'Business',
                tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT']
            });
        });

        it('should verify valid token', async () => {
            const mockGet = jest.fn().mockResolvedValue({ _data: { id: 'user123' } });
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet,
            }));

            const result = await service.verifyToken(mockAccessToken);

            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(User).toHaveBeenCalledWith('me');
            expect(mockGet).toHaveBeenCalledWith(['id']);
            expect(result).toEqual({ valid: true });
        });

        it('should return invalid for expired token', async () => {
            const mockGet = jest.fn().mockRejectedValue({
                response: {
                    status: 401
                }
            });
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet,
            }));

            const result = await service.verifyToken(mockAccessToken);

            expect(result).toEqual({ valid: false, error: 'Token expired or revoked' });
        });

        it('should return invalid for revoked permissions', async () => {
            const mockGet = jest.fn().mockRejectedValue({
                response: {
                    status: 403
                }
            });
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet,
            }));

            const result = await service.verifyToken(mockAccessToken);

            expect(result).toEqual({ valid: false, error: 'Token permissions revoked' });
        });

        it('should get user profile', async () => {
            const mockUserData = {
                id: 'user123',
                name: 'Test User',
                email: 'test@example.com'
            };
            const mockGet = jest.fn().mockResolvedValue(mockUserData);
            (User as unknown as jest.Mock).mockImplementation(() => ({
                get: mockGet,
            }));

            const result = await service.getUserProfile(mockAccessToken);

            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(User).toHaveBeenCalledWith('me');
            expect(mockGet).toHaveBeenCalledWith(['id', 'name', 'email']);
            expect(result).toEqual({
                id: 'user123',
                name: 'Test User',
                email: 'test@example.com'
            });
        });
    });

    describe('Pixel & Dataset Operations', () => {
        // These methods use dynamic import of fetchWithRetry, so we mock at global fetch level
        let mockFetch: jest.SpyInstance;

        beforeEach(() => {
            mockFetch = jest.spyOn(global, 'fetch');
        });

        afterEach(() => {
            mockFetch.mockRestore();
        });

        it('should list pixels for an ad account', async () => {
            const mockPixels = [{ id: 'pixel_1', name: 'Pixel 1' }];
            mockFetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ data: mockPixels })
            });

            const result = await service.listPixels(mockAdAccountId, mockAccessToken);
            expect(result).toEqual(mockPixels);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining(`act_${mockAdAccountId}/adspixels`)
            );
        });

        it('should list datasets for a pixel', async () => {
            const mockDatasets = [{ id: 'ds_1', name: 'Dataset 1' }];
            mockFetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ data: mockDatasets })
            });

            const result = await service.listDatasets('pixel_1', mockAccessToken);
            expect(result).toEqual(mockDatasets);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('pixel_1/datasets')
            );
        });

        it('should get dataset event stats', async () => {
            const mockStats = {
                id: 'ds_1',
                name: 'My Dataset',
                event_stats: [{ event: 'Purchase', emq_score: 8.0 }]
            };
            mockFetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue(mockStats)
            });

            const result = await service.getDatasetEventStats('ds_1', mockAccessToken);
            expect(result).toEqual(mockStats);
            expect(mockFetch).toHaveBeenCalledWith(
                expect.stringContaining('ds_1?fields=id,name,event_stats')
            );
        });

        it('should handle API errors in listPixels', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({ error: { message: 'Permission denied' } })
            });

            await expect(service.listPixels(mockAdAccountId, mockAccessToken)).rejects.toThrow('Permission denied');
        });

        it('should return empty array when no pixel data', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({})
            });

            const result = await service.listPixels(mockAdAccountId, mockAccessToken);
            expect(result).toEqual([]);
        });
    });

    describe('getPageInstagramActor', () => {
        it('returns the instagram_business_account id linked to the page', async () => {
            const mockCall = jest.fn().mockResolvedValue({
                _data: { instagram_business_account: { id: '17841469032554858' } }
            });
            (FacebookAdsApi.init as jest.Mock).mockReturnValue({ call: mockCall });

            const result = await service.getPageInstagramActor(mockAccessToken, '383736054827460');

            expect(result).toBe('17841469032554858');
            expect(mockCall).toHaveBeenCalledWith('GET', ['383736054827460'], expect.objectContaining({
                fields: expect.stringContaining('instagram_business_account')
            }));
        });

        it('falls back to connected_instagram_account when no business account', async () => {
            const mockCall = jest.fn().mockResolvedValue({
                _data: { connected_instagram_account: { id: '999' } }
            });
            (FacebookAdsApi.init as jest.Mock).mockReturnValue({ call: mockCall });

            const result = await service.getPageInstagramActor(mockAccessToken, 'page_1');
            expect(result).toBe('999');
        });

        it('falls back to the matching Page access token when the user token has no linked Instagram actor', async () => {
            const mockUserTokenCall = jest.fn().mockResolvedValue({ _data: {} });
            const mockPageTokenCall = jest.fn().mockResolvedValue({
                _data: { instagram_business_account: { id: '17841469032554858' } }
            });
            (FacebookAdsApi.init as jest.Mock).mockImplementation((token: string) => ({
                call: token === 'page_token_123' ? mockPageTokenCall : mockUserTokenCall,
            }));
            (User as unknown as jest.Mock).mockImplementation(() => ({
                getAccounts: jest.fn().mockResolvedValue([
                    {
                        id: 'page_1',
                        _data: {
                            id: 'page_1',
                            name: 'Test Page',
                            access_token: 'page_token_123',
                        }
                    }
                ]),
            }));

            const result = await service.getPageInstagramActor(mockAccessToken, 'page_1');

            expect(result).toBe('17841469032554858');
            expect(FacebookAdsApi.init).toHaveBeenCalledWith(mockAccessToken);
            expect(FacebookAdsApi.init).toHaveBeenCalledWith('page_token_123');
            expect(mockPageTokenCall).toHaveBeenCalledWith('GET', ['page_1'], expect.objectContaining({
                fields: expect.stringContaining('instagram_business_account')
            }));
        });

        it('returns null when the page has no linked Instagram account', async () => {
            const mockCall = jest.fn().mockResolvedValue({ _data: {} });
            (FacebookAdsApi.init as jest.Mock).mockReturnValue({ call: mockCall });

            const result = await service.getPageInstagramActor(mockAccessToken, 'page_1');
            expect(result).toBeNull();
        });

        it('returns null (non-fatal) when the Graph call throws', async () => {
            const mockCall = jest.fn().mockRejectedValue(new Error('boom'));
            (FacebookAdsApi.init as jest.Mock).mockReturnValue({ call: mockCall });

            const result = await service.getPageInstagramActor(mockAccessToken, 'page_1');
            expect(result).toBeNull();
        });
    });

    describe('placementTokenTargetsInstagram', () => {
        it('is true for IG-serving tokens and false for FB-only tokens', () => {
            expect(MetaService.placementTokenTargetsInstagram('reels')).toBe(true);
            expect(MetaService.placementTokenTargetsInstagram('story')).toBe(true);
            expect(MetaService.placementTokenTargetsInstagram('instagram_reels')).toBe(true);
            expect(MetaService.placementTokenTargetsInstagram('facebook_reels')).toBe(false);
            expect(MetaService.placementTokenTargetsInstagram('facebook_feed')).toBe(false);
            expect(MetaService.placementTokenTargetsInstagram('unknown')).toBe(false);
        });
    });
});
