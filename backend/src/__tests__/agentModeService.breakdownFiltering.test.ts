import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn().mockResolvedValue([])
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/mock-bucket/mock-file.csv',
    key: 'mock-key'
  })
}));

describe('AgentModeService - Breakdown Data Filtering', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getMetaAdsMetrics with campaign filtering', () => {
    it('should filter breakdown data by campaign when campaign_id is provided', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'facebook',
            account_name: 'Test Account',
            config: {
              account_type: 'ad_account',
              ad_account_id: '123456789',
              access_token: 'mock-access-token'
            }
          }
        ]
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('breakdowns=publisher_platform,platform_position')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  publisher_platform: 'facebook',
                  platform_position: 'feed',
                  impressions: '1000',
                  clicks: '50',
                  spend: '100.00',
                  websiteLeads: 5,
                  formLeads: 3,
                  campaign_id: 'camp1'  // FB_Prospecting
                },
                {
                  publisher_platform: 'instagram',
                  platform_position: 'feed',
                  impressions: '500',
                  clicks: '25',
                  spend: '50.00',
                  websiteLeads: 2,
                  formLeads: 1,
                  campaign_id: 'camp2'  // Other Campaign
                }
              ]
            })
          });
        }
        
        if (url.includes('breakdowns=age,gender')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  age: '25-34',
                  gender: 'male',
                  impressions: '800',
                  clicks: '40',
                  spend: '80.00',
                  websiteLeads: 4,
                  formLeads: 2,
                  campaign_id: 'camp1'  // FB_Prospecting
                },
                {
                  age: '35-44',
                  gender: 'female',
                  impressions: '600',
                  clicks: '30',
                  spend: '60.00',
                  websiteLeads: 3,
                  formLeads: 1,
                  campaign_id: 'camp2'  // Other Campaign
                }
              ]
            })
          });
        }
        
        if (url.includes('breakdowns=impression_device')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  impression_device: 'iPhone',
                  impressions: '1200',
                  clicks: '60',
                  spend: '120.00',
                  websiteLeads: 6,
                  formLeads: 3,
                  campaign_id: 'camp1'  // FB_Prospecting
                },
                {
                  impression_device: 'Android',
                  impressions: '400',
                  clicks: '20',
                  spend: '40.00',
                  websiteLeads: 2,
                  formLeads: 1,
                  campaign_id: 'camp2'  // Other Campaign
                }
              ]
            })
          });
        }
        
        // For all other API calls, return empty data
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      // Test with campaign_id filter
      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', ['camp1']);

      expect(result.success).toBe(true);

      // Validate filtering by checking generated CSV contents
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;

      const placementCall = uploadMock.mock.calls.find((call: any) => call[1].includes('placement-breakdown'));
      const demographicsCall = uploadMock.mock.calls.find((call: any) => call[1].includes('demographics-breakdown'));
      const deviceCall = uploadMock.mock.calls.find((call: any) => call[1].includes('device-breakdown'));

      const placementCsv = placementCall?.[0]?.toString() || '';
      const demographicsCsv = demographicsCall?.[0]?.toString() || '';
      const deviceCsv = deviceCall?.[0]?.toString() || '';

      expect(placementCsv).toContain('facebook');
      expect(placementCsv).not.toContain('instagram');
      expect(demographicsCsv).toContain('25-34');
      expect(demographicsCsv).not.toContain('35-44');
      expect(deviceCsv).toContain('iPhone');
      expect(deviceCsv).not.toContain('Android');
    });

    it('should return all breakdown data when multiple campaign_ids are provided', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'facebook',
            account_name: 'Test Account',
            config: {
              account_type: 'ad_account',
              ad_account_id: '123456789',
              access_token: 'mock-access-token'
            }
          }
        ]
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('breakdowns=publisher_platform,platform_position')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  publisher_platform: 'facebook',
                  platform_position: 'feed',
                  impressions: '1000',
                  clicks: '50',
                  spend: '100.00',
                  websiteLeads: 5,
                  formLeads: 3,
                  campaign_id: 'camp1'
                },
                {
                  publisher_platform: 'instagram',
                  platform_position: 'feed',
                  impressions: '500',
                  clicks: '25',
                  spend: '50.00',
                  websiteLeads: 2,
                  formLeads: 1,
                  campaign_id: 'camp2'
                }
              ]
            })
          });
        }
        
        // For all other API calls, return empty data
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      // Test with both campaign IDs
      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', ['camp1', 'camp2']);

      expect(result.success).toBe(true);

      // Check that both placements are present in generated placement CSV
      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;
      const placementCall = uploadMock.mock.calls.find((call: any) => call[1].includes('placement-breakdown'));
      const placementCsv = placementCall?.[0]?.toString() || '';
      expect(placementCsv).toContain('facebook');
      expect(placementCsv).toContain('instagram');
    });
  });

  describe('processBreakdownData', () => {
    it('should process placement breakdown data correctly', () => {
      const mockPlacementData = [
        {
          publisher_platform: 'facebook',
          platform_position: 'feed',
          impressions: '1000',
          clicks: '50',
          spend: '100.00',
          websiteLeads: 5,
          formLeads: 3,
          campaign_id: 'camp1'
        },
        {
          publisher_platform: 'facebook',
          platform_position: 'feed',
          impressions: '2000',
          clicks: '100',
          spend: '200.00',
          websiteLeads: 8,
          formLeads: 2,
          campaign_id: 'camp1'
        }
      ];

      const result = (agentModeService as any).processBreakdownData(mockPlacementData);

      expect(result).toHaveLength(2);
      expect(result[0].publisher_platform).toBe('facebook');
      expect(result[0].platform_position).toBe('feed');
      expect(result[0].impressions).toBe('1000');
      expect(result[0].spend).toBe('100.00');
    });
  });

  describe('formatMetricsSummary - Breakdown Data Aggregation', () => {
    it('should aggregate placement data correctly with all lead types', async () => {
      const mockData = {
        adPerformance: [],
        adSetsData: [],
        adsData: [],
        campaignSummary: { 
          totalSpend: 350,
          totalCampaigns: 1,
          totalImpressions: 10000,
          totalClicks: 200,
          averageCtr: 2.0,
          averageCpc: 1.75,
          totalWebsiteLeads: 15,
          totalFormLeads: 5,
          totalLeads: 20,
          averageCostPerWebsiteLead: 23.33,
          averageCostPerFormLead: 70.0,
          averageCostPerLead: 17.5
        },
        demographicsBreakdown: [],
        placementBreakdown: [
          {
            publisher_platform: 'facebook',
            platform_position: 'feed',
            impressions: '1000',
            clicks: '50',
            spend: '100.00',
            websiteLeads: 5,
            formLeads: 3
          },
          {
            publisher_platform: 'facebook',
            platform_position: 'feed',
            impressions: '2000',
            clicks: '100',
            spend: '200.00',
            websiteLeads: 8,
            formLeads: 2
          },
          {
            publisher_platform: 'instagram',
            platform_position: 'feed',
            impressions: '500',
            clicks: '25',
            spend: '50.00',
            websiteLeads: 2,
            formLeads: 1
          }
        ],
        deviceBreakdown: [],
        attributionWindow: { start: '2025-01-01', end: '2025-01-07', days: 7 },
        timeframe: '7d'
      };

      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;
      uploadMock.mockClear();
      
      const result = await (agentModeService as any).formatMetricsSummary(mockData, 'test-user-id');

      // Verify uploadFileToS3 was called with placement CSV
      expect(uploadMock).toHaveBeenCalled();
      const placementCall = uploadMock.mock.calls.find((call: any) => 
        call[1].includes('placement-breakdown')
      );
      expect(placementCall).toBeDefined();
      
      // Parse and verify the CSV content
      const csvContent = placementCall[0].toString();
      const lines = csvContent.split('\n');
      
      // Check CSV headers
      expect(lines[0]).toContain('Platform');
      expect(lines[0]).toContain('Position');
      expect(lines[0]).toContain('Impressions');
      
      // Check aggregated data (should have 2 rows: facebook-feed aggregated + instagram-feed)
      const dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);
      expect(dataLines.length).toBe(2);
      
      // Verify facebook-feed aggregated values in the CSV (sorted by spend, so should be first)
      const facebookLine = dataLines[0];
      expect(facebookLine).toContain('facebook');
      expect(facebookLine).toContain('feed');
      expect(facebookLine).toContain('3000'); // 1000 + 2000 impressions
      expect(facebookLine).toContain('150'); // 50 + 100 clicks
      expect(facebookLine).toContain('$300.00'); // 100 + 200 spend
      
      // Check that campaign summary is included in result
      expect(result).toContain('Campaign Summary');
    });

    it('should aggregate device data correctly with all lead types', async () => {
      const mockData = {
        adPerformance: [],
        adSetsData: [],
        adsData: [],
        campaignSummary: { 
          totalSpend: 200,
          totalCampaigns: 1,
          totalImpressions: 5000,
          totalClicks: 100,
          averageCtr: 2.0,
          averageCpc: 2.0,
          totalWebsiteLeads: 8,
          totalFormLeads: 2,
          totalLeads: 10,
          averageCostPerWebsiteLead: 25.0,
          averageCostPerFormLead: 100.0,
          averageCostPerLead: 20.0
        },
        demographicsBreakdown: [],
        placementBreakdown: [],
        deviceBreakdown: [
          {
            impression_device: 'iPhone',
            impressions: '1000',
            clicks: '50',
            spend: '100.00',
            websiteLeads: 5,
            formLeads: 3
          },
          {
            impression_device: 'iPhone',
            impressions: '2000',
            clicks: '100',
            spend: '200.00',
            websiteLeads: 8,
            formLeads: 2
          },
          {
            impression_device: 'Android',
            impressions: '500',
            clicks: '25',
            spend: '50.00',
            websiteLeads: 2,
            formLeads: 1
          }
        ],
        attributionWindow: { start: '2025-01-01', end: '2025-01-07', days: 7 },
        timeframe: '7d'
      };

      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;
      uploadMock.mockClear();
      
      const result = await (agentModeService as any).formatMetricsSummary(mockData, 'test-user-id');

      // Verify uploadFileToS3 was called with device CSV
      expect(uploadMock).toHaveBeenCalled();
      const deviceCall = uploadMock.mock.calls.find((call: any) => 
        call[1].includes('device-breakdown')
      );
      expect(deviceCall).toBeDefined();
      
      // Parse and verify the CSV content
      const csvContent = deviceCall[0].toString();
      const lines = csvContent.split('\n');
      
      // Check CSV headers
      expect(lines[0]).toContain('Device');
      expect(lines[0]).toContain('Impressions');
      expect(lines[0]).toContain('Clicks');
      
      // Check aggregated data (should have 2 rows: iPhone aggregated + Android)
      const dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);
      expect(dataLines.length).toBe(2);
      
      // Verify iPhone aggregated values in the CSV (sorted by spend, so should be first)
      const iPhoneLine = dataLines[0];
      expect(iPhoneLine).toContain('iPhone');
      expect(iPhoneLine).toContain('3000'); // 1000 + 2000 impressions
      expect(iPhoneLine).toContain('150'); // 50 + 100 clicks
      expect(iPhoneLine).toContain('$300.00'); // 100 + 200 spend
      
      // Check that campaign summary is included in result
      expect(result).toContain('Campaign Summary');
    });

    it('should include explanatory note about breakdown data limitations', async () => {
      const mockData = {
        adPerformance: [],
        adSetsData: [],
        adsData: [],
        campaignSummary: { 
          totalSpend: 100,
          totalCampaigns: 1,
          totalImpressions: 2000,
          totalClicks: 50,
          averageCtr: 2.5,
          averageCpc: 2.0,
          totalWebsiteLeads: 4,
          totalFormLeads: 1,
          totalLeads: 5,
          averageCostPerWebsiteLead: 25.0,
          averageCostPerFormLead: 100.0,
          averageCostPerLead: 20.0
        },
        demographicsBreakdown: [],
        placementBreakdown: [],
        deviceBreakdown: [],
        attributionWindow: { start: '2025-01-01', end: '2025-01-07', days: 7 },
        timeframe: '7d'
      };

      const result = await (agentModeService as any).formatMetricsSummary(mockData, 'test-user-id');

      // Check that explanatory note is included
      expect(result).toContain('Breakdown data (demographics, placement, device) only includes spend from ads with sufficient data for those breakdowns');
      expect(result).toContain('Breakdown totals may not match campaign totals due to this limitation');
    });
  });

  describe('Campaign filtering edge cases', () => {
    it('should accept legacy single campaign ID string input', async () => {
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'facebook',
            account_name: 'Test Account',
            config: {
              account_type: 'ad_account',
              ad_account_id: '123456789',
              access_token: 'mock-access-token'
            }
          }
        ]
      };

      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const capturedUrls: string[] = [];

      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', 'camp1');

      expect(result.success).toBe(true);
      const insightsUrl = capturedUrls.find(url => url.includes('insights?fields='));
      expect(insightsUrl).toContain('filtering=');
      expect(insightsUrl).toContain('camp1');
    });

    it('should filter by campaign_id when provided', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'facebook',
            account_name: 'Test Account',
            config: {
              account_type: 'ad_account',
              ad_account_id: '123456789',
              access_token: 'mock-access-token'
            }
          }
        ]
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      let capturedUrls: string[] = [];

      // Mock fetch to capture filtering parameter
      global.fetch = jest.fn().mockImplementation((url: string) => {
        capturedUrls.push(url);

        // For all API calls, return empty data
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      // Test with campaign_id filter
      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', ['camp1']);

      expect(result.success).toBe(true);

      // Verify that filtering parameter is included in API calls
      const insightsUrl = capturedUrls.find(url => url.includes('insights?fields='));
      expect(insightsUrl).toBeDefined();
      expect(insightsUrl).toContain('filtering=');
      expect(insightsUrl).toContain('campaign.id');
      expect(insightsUrl).toContain('camp1');
    });

    it('should handle case when breakdown data has no campaign_id field', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789',
        connected_accounts: [
          {
            platform: 'facebook',
            account_name: 'Test Account',
            config: {
              account_type: 'ad_account',
              ad_account_id: '123456789',
              access_token: 'mock-access-token'
            }
          }
        ]
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return data without campaign_id
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('breakdowns=publisher_platform,platform_position')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  publisher_platform: 'facebook',
                  platform_position: 'feed',
                  impressions: '1000',
                  clicks: '50',
                  spend: '100.00',
                  websiteLeads: 5,
                  formLeads: 3
                  // No campaign_id field
                }
              ]
            })
          });
        }

        // For all other API calls, return empty data
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      // Test with campaign_id filter
      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', ['camp1']);

      expect(result.success).toBe(true);

      // Check that placement breakdown section is not generated when filtered data is empty
      expect(result.formattedContent).not.toContain('Placement Breakdown');
    });
  });
});
