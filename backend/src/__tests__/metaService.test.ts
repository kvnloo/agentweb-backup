
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
        AdCreative: {
            Fields: {
                name: 'name',
                object_story_spec: 'object_story_spec',
            }
        },
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

        it('should create a lookalike audience', async () => {
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
                    origin: [{ id: 'source_audience_123' }],
                    country: 'US'
                },
            };

            const result = await service.createCustomAudience(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCustomAudience).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'Lookalike Audience',
                subtype: 'LOOKALIKE',
                lookalike_spec: expect.objectContaining({
                    ratio: 0.01,
                    country: 'US',
                }),
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
                    owner: 'user123',
                    business: { id: 'biz123', name: 'Test Business' }
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
                expect.arrayContaining(['id', 'name', 'account_id', 'currency', 'account_status', 'owner', 'business'])
            );
            expect(result).toEqual(mockAdAccounts);
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
});
