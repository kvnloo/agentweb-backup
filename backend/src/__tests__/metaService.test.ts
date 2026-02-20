
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

        it('should create a basic single image ad creative', async () => {
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
                description: 'Ad Description',
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
                        name: 'Ad Title',
                        description: 'Ad Description',
                        link: 'http://example.com',
                    }),
                }),
            }));
            expect(result).toEqual(mockCreativeData);
        });

        it('should create an ad creative with asset_feed_spec for multiple text variants', async () => {
            const mockCreativeData = { id: 'creative_dyn', name: 'Dynamic Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'Dynamic Creative',
                page_id: 'page_123',
                image_url: 'http://example.com/image.jpg',
                body: 'Ad Body 1',
                extra_bodies: ['Ad Body 2'],
                title: 'Ad Title 1',
                extra_titles: ['Ad Title 2'],
                description: 'Ad Desc 1',
                extra_descriptions: ['Ad Desc 2'],
                link_url: 'http://example.com',
                call_to_action_type: 'LEARN_MORE',
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCreative).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'Dynamic Creative',
                object_story_spec: { page_id: 'page_123' },
                asset_feed_spec: expect.objectContaining({
                    ad_formats: ['SINGLE_IMAGE'],
                    bodies: [{ text: 'Ad Body 1' }, { text: 'Ad Body 2' }],
                    titles: [{ text: 'Ad Title 1' }, { text: 'Ad Title 2' }],
                    descriptions: [{ text: 'Ad Desc 1' }, { text: 'Ad Desc 2' }],
                    images: [{ url: 'http://example.com/image.jpg' }],
                }),
            }));
            expect(result).toEqual(mockCreativeData);
        });

        it('should create a basic video ad creative', async () => {
            const mockCreativeData = { id: 'creative_vid', name: 'Video Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'Video Creative',
                page_id: 'page_123',
                video_id: 'vid_123',
                image_hash: 'thumb_hash_123',
                body: 'Video Body',
                title: 'Video Title',
                link_url: 'http://example.com',
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCreative).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'Video Creative',
                object_story_spec: expect.objectContaining({
                    page_id: 'page_123',
                    video_data: expect.objectContaining({
                        video_id: 'vid_123',
                        image_hash: 'thumb_hash_123',
                        message: 'Video Body',
                        title: 'Video Title',
                    }),
                }),
            }));
            expect(result).toEqual(mockCreativeData);
        });

        it('should create a video ad creative with asset_feed_spec for multiple text variants', async () => {
            const mockCreativeData = { id: 'creative_vid_dyn', name: 'Dynamic Video Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'Dynamic Video Creative',
                page_id: 'page_123',
                video_id: 'vid_123',
                image_hash: 'thumb_hash_123',
                body: 'Video Body 1',
                extra_bodies: ['Video Body 2'],
                title: 'Video Title 1',
                extra_titles: ['Video Title 2'],
                link_url: 'http://example.com',
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCreative).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'Dynamic Video Creative',
                object_story_spec: { page_id: 'page_123' },
                asset_feed_spec: expect.objectContaining({
                    ad_formats: ['SINGLE_VIDEO'],
                    bodies: [{ text: 'Video Body 1' }, { text: 'Video Body 2' }],
                    titles: [{ text: 'Video Title 1' }, { text: 'Video Title 2' }],
                    videos: [{ video_id: 'vid_123', thumbnail_hash: 'thumb_hash_123' }],
                }),
            }));
            expect(result).toEqual(mockCreativeData);
        });

        it('should create an ad creative with optimize_creative enabled', async () => {
            const mockCreativeData = { id: 'creative_opt', name: 'Optimized Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'Optimized Creative',
                page_id: 'page_123',
                image_url: 'http://example.com/image.jpg',
                body: 'Ad Body',
                title: 'Ad Title',
                link_url: 'http://example.com',
                optimize_creative: true,
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCreative).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'Optimized Creative',
                degrees_of_freedom_spec: {
                    creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' } },
                },
            }));
            expect(result).toEqual(mockCreativeData);
        });

        it('should create an ad creative without a website URL when add_website_url is false', async () => {
            const mockCreativeData = { id: 'creative_nourl', name: 'No URL Creative' };
            const mockCreateCreative = jest.fn().mockResolvedValue({ _data: mockCreativeData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdCreative: mockCreateCreative,
            }));

            const params = {
                name: 'No URL Creative',
                page_id: 'page_123',
                image_url: 'http://example.com/image.jpg',
                body: 'Ad Body',
                title: 'Ad Title',
                link_url: 'http://example.com',
                add_website_url: false,
                call_to_action_type: 'LEARN_MORE', // Should be omitted
            };

            const result = await service.createAdCreative(mockAdAccountId, mockAccessToken, params);

            expect(mockCreateCreative).toHaveBeenCalledWith([], expect.objectContaining({
                name: 'No URL Creative',
                object_story_spec: expect.objectContaining({
                    page_id: 'page_123',
                    link_data: expect.objectContaining({
                        message: 'Ad Body',
                        name: 'Ad Title',
                    }),
                }),
            }));

            // Assert that link, caption, and call_to_action are NOT present in link_data
            const createCallArgs = mockCreateCreative.mock.calls[0][1];
            expect(createCallArgs.object_story_spec.link_data.link).toBeUndefined();
            expect(createCallArgs.object_story_spec.link_data.caption).toBeUndefined();
            expect(createCallArgs.object_story_spec.link_data.call_to_action).toBeUndefined();
            
            expect(result).toEqual(mockCreativeData);
        });
    });

    describe('Ad Operations', () => {
        it('should list ads', async () => {
            const mockAds = [{ _data: { id: 'ad_1', name: 'Ad 1' } }];
            const mockGetAds = jest.fn().mockResolvedValue(mockAds);
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                getAds: mockGetAds,
            }));

            const result = await service.listAds(mockAdAccountId, mockAccessToken);

            expect(mockGetAds).toHaveBeenCalled();
            expect(result).toEqual([{ id: 'ad_1', name: 'Ad 1' }]);
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
        it('should upload an image', async () => {
            const mockImageData = { hash: 'image_hash_123' };
            const mockCreateAdImage = jest.fn().mockResolvedValue({ _data: mockImageData });
            (AdAccount as unknown as jest.Mock).mockImplementation(() => ({
                createAdImage: mockCreateAdImage,
            }));

            const filename = 'test-image.jpg';
            const fileBuffer = Buffer.from('test image data');

            const result = await service.uploadImage(mockAdAccountId, mockAccessToken, filename, fileBuffer);

            expect(AdAccount).toHaveBeenCalledWith(`act_${mockAdAccountId}`);
            expect(mockCreateAdImage).toHaveBeenCalledWith([], {
                filename: filename,
                bytes: fileBuffer.toString('base64'),
            });
            expect(result).toEqual(mockImageData);
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

        it('should filter out ad accounts without business', async () => {
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
                    name: 'Personal Account',
                    account_id: '456',
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
            expect(result[0].business).toBeTruthy();
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
});
