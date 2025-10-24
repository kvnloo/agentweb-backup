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

describe('AgentModeService - Custom Breakdowns', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getMetaAdsMetrics with custom breakdowns', () => {
    it('should use custom breakdowns when provided', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Track API calls to verify custom breakdowns are used
      const apiCalls: string[] = [];
      
      // Mock fetch to capture API calls and return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        apiCalls.push(url);
        
        if (url.includes('/campaigns') && !url.includes('filtering')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'Test Campaign' }
              ]
            })
          });
        }
        
        // Mock the custom breakdown response
        if (url.includes('breakdowns=age,gender') && url.includes('fields=campaign_name,adset_name,age,gender,impressions,reach,spend,ctr,cpc,link_clicks,quality_ranking,engagement_rate_ranking,conversion_rate_ranking')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  campaign_name: 'Test Campaign',
                  adset_name: 'Test Ad Set',
                  age: '25-34',
                  gender: 'male',
                  impressions: '1000',
                  reach: '800',
                  spend: '100.00',
                  ctr: '2.5',
                  cpc: '0.50',
                  link_clicks: '25',
                  quality_ranking: 'ABOVE_AVERAGE',
                  engagement_rate_ranking: 'AVERAGE',
                  conversion_rate_ranking: 'BELOW_AVERAGE',
                  campaign_id: 'camp1'
                },
                {
                  campaign_name: 'Test Campaign',
                  adset_name: 'Test Ad Set',
                  age: '35-44',
                  gender: 'female',
                  impressions: '800',
                  reach: '600',
                  spend: '80.00',
                  ctr: '3.0',
                  cpc: '0.40',
                  link_clicks: '24',
                  quality_ranking: 'AVERAGE',
                  engagement_rate_ranking: 'ABOVE_AVERAGE',
                  conversion_rate_ranking: 'AVERAGE',
                  campaign_id: 'camp1'
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

      // Test with custom breakdowns
      const customBreakdowns = {
        breakdowns: ['age', 'gender'],
        fields: ['campaign_name', 'adset_name', 'age', 'gender', 'impressions', 'reach', 'spend', 'ctr', 'cpc', 'link_clicks', 'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking']
      };

      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', undefined, customBreakdowns);

      expect(result.success).toBe(true);
      
      // Verify that custom breakdown API was called
      const customBreakdownCall = apiCalls.find(call => 
        call.includes('breakdowns=age,gender') && 
        call.includes('fields=campaign_name,adset_name,age,gender,impressions,reach,spend,ctr,cpc,link_clicks,quality_ranking,engagement_rate_ranking,conversion_rate_ranking')
      );
      expect(customBreakdownCall).toBeDefined();
      
      // Verify that default breakdown calls were not made
      const defaultDemographicsCall = apiCalls.find(call => 
        call.includes('breakdowns=age,gender') && 
        call.includes('fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id,adset_id,ad_id')
      );
      expect(defaultDemographicsCall).toBeUndefined();
      
      // Check that custom breakdown data is processed correctly
      const demographicsBreakdown = result.data.demographicsBreakdown;
      expect(demographicsBreakdown).toHaveLength(2);
      expect(demographicsBreakdown[0].age).toBe('25-34');
      expect(demographicsBreakdown[0].gender).toBe('male');
      expect(demographicsBreakdown[0].campaign_name).toBe('Test Campaign');
      expect(demographicsBreakdown[0].quality_ranking).toBe('ABOVE_AVERAGE');
      expect(demographicsBreakdown[1].age).toBe('35-44');
      expect(demographicsBreakdown[1].gender).toBe('female');
      expect(demographicsBreakdown[1].engagement_rate_ranking).toBe('ABOVE_AVERAGE');
    });

    it('should use default breakdowns when custom_breakdowns is not provided', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Track API calls to verify default breakdowns are used
      const apiCalls: string[] = [];
      
      // Mock fetch to capture API calls and return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        apiCalls.push(url);
        
        if (url.includes('/campaigns') && !url.includes('filtering')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'Test Campaign' }
              ]
            })
          });
        }
        
        // Mock default breakdown responses
        if (url.includes('breakdowns=age,gender') && url.includes('fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id,adset_id,ad_id')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  age: '25-34',
                  gender: 'male',
                  impressions: '1000',
                  clicks: '50',
                  spend: '100.00',
                  campaign_id: 'camp1'
                }
              ]
            })
          });
        }
        
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
                  campaign_id: 'camp1'
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
                  impressions: '1000',
                  clicks: '50',
                  spend: '100.00',
                  campaign_id: 'camp1'
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

      // Test without custom breakdowns
      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123');

      expect(result.success).toBe(true);
      
      // Verify that default breakdown APIs were called
      const demographicsCall = apiCalls.find(call => 
        call.includes('breakdowns=age,gender') && 
        call.includes('fields=impressions,clicks,spend,ctr,cpc,reach,actions,cost_per_action_type,campaign_id,adset_id,ad_id')
      );
      expect(demographicsCall).toBeDefined();
      
      const placementCall = apiCalls.find(call => 
        call.includes('breakdowns=publisher_platform,platform_position')
      );
      expect(placementCall).toBeDefined();
      
      const deviceCall = apiCalls.find(call => 
        call.includes('breakdowns=impression_device')
      );
      expect(deviceCall).toBeDefined();
      
      // Check that all default breakdown data is present
      expect(result.data.demographicsBreakdown).toHaveLength(1);
      expect(result.data.placementBreakdown).toHaveLength(1);
      expect(result.data.deviceBreakdown).toHaveLength(1);
    });

    it('should handle custom breakdowns with campaign filtering', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Track API calls to verify filtering is applied
      const apiCalls: string[] = [];
      
      // Mock fetch to capture API calls and return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        apiCalls.push(url);
        
        if (url.includes('/campaigns') && !url.includes('filtering')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'FB_Prospecting' },
                { id: 'camp2', name: 'Other Campaign' }
              ]
            })
          });
        }
        
        // Mock the custom breakdown response with filtering
        if (url.includes('breakdowns=age,gender') && url.includes('filtering=')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                {
                  campaign_name: 'FB_Prospecting',
                  adset_name: 'Test Ad Set',
                  age: '25-34',
                  gender: 'male',
                  impressions: '1000',
                  reach: '800',
                  spend: '100.00',
                  ctr: '2.5',
                  cpc: '0.50',
                  link_clicks: '25',
                  quality_ranking: 'ABOVE_AVERAGE',
                  engagement_rate_ranking: 'AVERAGE',
                  conversion_rate_ranking: 'BELOW_AVERAGE',
                  campaign_id: 'camp1'
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

      // Test with custom breakdowns and campaign filtering
      const customBreakdowns = {
        breakdowns: ['age', 'gender'],
        fields: ['campaign_name', 'adset_name', 'age', 'gender', 'impressions', 'reach', 'spend', 'ctr', 'cpc', 'link_clicks', 'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking']
      };

      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', 'FB_Prospecting', customBreakdowns);

      expect(result.success).toBe(true);
      
      // Verify that filtering was applied to the custom breakdown call
      const customBreakdownCall = apiCalls.find(call => 
        call.includes('breakdowns=age,gender') && 
        call.includes('filtering=')
      );
      expect(customBreakdownCall).toBeDefined();
      expect(customBreakdownCall).toContain('campaign.id');
      expect(customBreakdownCall).toContain('camp1');
      
      // Check that only filtered data is returned
      const demographicsBreakdown = result.data.demographicsBreakdown;
      expect(demographicsBreakdown).toHaveLength(1);
      expect(demographicsBreakdown[0].campaign_name).toBe('FB_Prospecting');
      expect(demographicsBreakdown[0].campaign_id).toBe('camp1');
    });

    it('should handle empty custom breakdowns gracefully', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/campaigns') && !url.includes('filtering')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'Test Campaign' }
              ]
            })
          });
        }
        
        // For all other API calls, return empty data
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      // Test with empty custom breakdowns (should fall back to default)
      const customBreakdowns = {
        breakdowns: [],
        fields: []
      };

      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', undefined, customBreakdowns);

      expect(result.success).toBe(true);
      
      // Should use default breakdowns when custom breakdowns are empty
      expect(result.data.demographicsBreakdown).toBeDefined();
      expect(result.data.placementBreakdown).toBeDefined();
      expect(result.data.deviceBreakdown).toBeDefined();
    });

    it('should handle partial custom breakdowns gracefully', async () => {
      // Mock user data
      const mockUser = {
        id: 'user123',
        adAccount: '123456789'
      };

      // Mock the userDb.getUserById to return the mock user
      const { userDb } = await import('../services/db');
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      // Mock fetch to return sample data
      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('/campaigns') && !url.includes('filtering')) {
          return Promise.resolve({
            json: () => Promise.resolve({
              data: [
                { id: 'camp1', name: 'Test Campaign' }
              ]
            })
          });
        }
        
        // For all other API calls, return empty data
        return Promise.resolve({
          json: () => Promise.resolve({ data: [] })
        });
      });

      // Test with partial custom breakdowns (missing fields)
      const customBreakdowns = {
        breakdowns: ['age', 'gender'],
        fields: [] // Empty fields array
      };

      const result = await (agentModeService as any).getMetaAdsMetrics('7d', 'user123', undefined, customBreakdowns);

      expect(result.success).toBe(true);
      
      // Should use default breakdowns when custom breakdowns are incomplete
      expect(result.data.demographicsBreakdown).toBeDefined();
      expect(result.data.placementBreakdown).toBeDefined();
      expect(result.data.deviceBreakdown).toBeDefined();
    });
  });
});
