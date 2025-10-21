import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService - Breakdown Data Aggregation', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
  });

  describe('formatMetricsSummary - Placement Breakdown Aggregation', () => {
    it('should aggregate multiple placement entries correctly', () => {
      const mockData = {
        adPerformance: [],
        adSetsData: [],
        adsData: [],
        campaignSummary: { 
          totalSpend: 300,
          totalCampaigns: 1,
          totalImpressions: 10000,
          totalClicks: 200,
          averageCtr: 2.0,
          averageCpc: 1.5,
          totalWebsiteLeads: 10,
          totalFormLeads: 5,
          totalLeads: 15,
          averageCostPerWebsiteLead: 30.0,
          averageCostPerFormLead: 60.0,
          averageCostPerLead: 20.0
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
          }
        ],
        deviceBreakdown: [],
        attributionWindow: { start: '2025-01-01', end: '2025-01-07', days: 7 },
        timeframe: '7d'
      };

      const result = (agentModeService as any).formatMetricsSummary(mockData);

      // Check that placement breakdown is included
      expect(result).toContain('Placement Performance');
      
      // Check that facebook-feed appears only once (aggregated)
      const facebookFeedLines = result.split('\n').filter(line => 
        line.includes('facebook') && line.includes('feed')
      );
      expect(facebookFeedLines).toHaveLength(1);
      
      // Check aggregated values
      expect(result).toContain('$300.00'); // 100 + 200
      expect(result).toContain('13'); // 5 + 8 website leads
      expect(result).toContain('5'); // 3 + 2 form leads
      expect(result).toContain('18'); // 13 + 5 total leads
    });

    it('should handle empty breakdown data gracefully', () => {
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

      const result = (agentModeService as any).formatMetricsSummary(mockData);

      // Should not contain breakdown sections when data is empty
      expect(result).not.toContain('Placement Performance');
      expect(result).not.toContain('Demographics Performance');
      expect(result).not.toContain('Device Performance');
    });
  });

  describe('formatMetricsSummary - Device Breakdown Aggregation', () => {
    it('should aggregate multiple device entries correctly', () => {
      const mockData = {
        adPerformance: [],
        adSetsData: [],
        adsData: [],
        campaignSummary: { 
          totalSpend: 250,
          totalCampaigns: 1,
          totalImpressions: 8000,
          totalClicks: 160,
          averageCtr: 2.0,
          averageCpc: 1.56,
          totalWebsiteLeads: 8,
          totalFormLeads: 4,
          totalLeads: 12,
          averageCostPerWebsiteLead: 31.25,
          averageCostPerFormLead: 62.5,
          averageCostPerLead: 20.83
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

      const result = (agentModeService as any).formatMetricsSummary(mockData);

      // Check that device breakdown is included
      expect(result).toContain('Device Performance');
      
      // Check that iPhone appears only once (aggregated)
      const iPhoneLines = result.split('\n').filter(line => 
        line.includes('iPhone')
      );
      expect(iPhoneLines).toHaveLength(1);
      
      // Check aggregated values for iPhone
      expect(result).toContain('$300.00'); // 100 + 200
      expect(result).toContain('13'); // 5 + 8 website leads
      expect(result).toContain('5'); // 3 + 2 form leads
      expect(result).toContain('18'); // 13 + 5 total leads
    });
  });

  describe('formatMetricsSummary - Demographics Breakdown Aggregation', () => {
    it('should aggregate multiple demographics entries correctly', () => {
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
          totalWebsiteLeads: 6,
          totalFormLeads: 3,
          totalLeads: 9,
          averageCostPerWebsiteLead: 33.33,
          averageCostPerFormLead: 66.67,
          averageCostPerLead: 22.22
        },
        demographicsBreakdown: [
          {
            age: '25-34',
            gender: 'male',
            impressions: '1000',
            clicks: '50',
            spend: '100.00',
            websiteLeads: 5,
            formLeads: 3
          },
          {
            age: '25-34',
            gender: 'male',
            impressions: '2000',
            clicks: '100',
            spend: '200.00',
            websiteLeads: 8,
            formLeads: 2
          }
        ],
        placementBreakdown: [],
        deviceBreakdown: [],
        attributionWindow: { start: '2025-01-01', end: '2025-01-07', days: 7 },
        timeframe: '7d'
      };

      const result = (agentModeService as any).formatMetricsSummary(mockData);

      // Check that demographics breakdown is included
      expect(result).toContain('Demographics Performance');
      
      // Check that 25-34 male appears only once (aggregated)
      const male2534Lines = result.split('\n').filter(line => 
        line.includes('25-34') && line.includes('male')
      );
      expect(male2534Lines).toHaveLength(1);
      
      // Check aggregated values
      expect(result).toContain('$300.00'); // 100 + 200
      expect(result).toContain('13'); // 5 + 8 website leads
      expect(result).toContain('5'); // 3 + 2 form leads
      expect(result).toContain('18'); // 13 + 5 total leads
    });
  });

  describe('Cost per Lead Calculations', () => {
    it('should calculate cost per lead correctly using total leads', () => {
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
        placementBreakdown: [
          {
            publisher_platform: 'facebook',
            platform_position: 'feed',
            impressions: '1000',
            clicks: '50',
            spend: '100.00',
            websiteLeads: 4,
            formLeads: 1
          }
        ],
        deviceBreakdown: [],
        attributionWindow: { start: '2025-01-01', end: '2025-01-07', days: 7 },
        timeframe: '7d'
      };

      const result = (agentModeService as any).formatMetricsSummary(mockData);

      // Check that cost per lead is calculated using total leads (4 + 1 = 5)
      // 100 / 5 = 20
      expect(result).toContain('$20.00');
    });
  });
});
