import { AgentModeService } from '../services/agentModeService';

// Mock S3 utils
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/mock-bucket/mock-file.csv',
    key: 'mock-key'
  })
}));

describe('AgentModeService - Breakdown Data Aggregation', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('formatMetricsSummary - Placement Breakdown Aggregation', () => {
    it('should aggregate multiple placement entries correctly', async () => {
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

      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;
      
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
      expect(lines[0]).toContain('Clicks');
      expect(lines[0]).toContain('Spend');
      
      // Check aggregated data (should have only 1 row for facebook-feed)
      const dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);
      expect(dataLines.length).toBe(1);
      
      // Verify aggregated values in the CSV
      const dataLine = dataLines[0];
      expect(dataLine).toContain('facebook');
      expect(dataLine).toContain('feed');
      expect(dataLine).toContain('3000'); // 1000 + 2000 impressions
      expect(dataLine).toContain('150'); // 50 + 100 clicks
      expect(dataLine).toContain('$300.00'); // 100 + 200 spend
      expect(dataLine).toContain('13'); // 5 + 8 website leads
      expect(dataLine).toContain('5'); // 3 + 2 form leads
      expect(dataLine).toContain('18'); // 13 + 5 total leads
      
      // Check that campaign summary is included in result
      expect(result).toContain('Campaign Summary');
      expect(result).toContain('$300.00');
    });

    it('should handle empty breakdown data gracefully', async () => {
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

      // Should contain campaign summary but not breakdown CSV files
      expect(result).toContain('Campaign Summary');
      expect(result).not.toContain('Placement Breakdown');
      expect(result).not.toContain('Demographics Breakdown');
      expect(result).not.toContain('Device Breakdown');
    });
  });

  describe('formatMetricsSummary - Device Breakdown Aggregation', () => {
    it('should aggregate multiple device entries correctly', async () => {
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

      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;
      
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
      expect(lines[0]).toContain('Spend');
      
      // Check aggregated data (should have 2 rows: iPhone aggregated + Android)
      const dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);
      expect(dataLines.length).toBe(2);
      
      // Verify iPhone aggregated values in the CSV
      const iPhoneLine = dataLines.find((line: string) => line.includes('iPhone'));
      expect(iPhoneLine).toBeDefined();
      expect(iPhoneLine).toContain('3000'); // 1000 + 2000 impressions
      expect(iPhoneLine).toContain('150'); // 50 + 100 clicks
      expect(iPhoneLine).toContain('$300.00'); // 100 + 200 spend
      expect(iPhoneLine).toContain('13'); // 5 + 8 website leads
      expect(iPhoneLine).toContain('5'); // 3 + 2 form leads
      expect(iPhoneLine).toContain('18'); // 13 + 5 total leads
      
      // Check that campaign summary is included in result
      expect(result).toContain('Campaign Summary');
    });
  });

  describe('formatMetricsSummary - Demographics Breakdown Aggregation', () => {
    it('should aggregate multiple demographics entries correctly', async () => {
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

      const { uploadFileToS3 } = await import('../utils/s3Utils');
      const uploadMock = uploadFileToS3 as jest.Mock;
      
      const result = await (agentModeService as any).formatMetricsSummary(mockData, 'test-user-id');

      // Verify uploadFileToS3 was called with demographics CSV
      expect(uploadMock).toHaveBeenCalled();
      const demoCall = uploadMock.mock.calls.find((call: any) => 
        call[1].includes('demographics-breakdown')
      );
      expect(demoCall).toBeDefined();
      
      // Parse and verify the CSV content
      const csvContent = demoCall[0].toString();
      const lines = csvContent.split('\n');
      
      // Check CSV headers
      expect(lines[0]).toContain('Age');
      expect(lines[0]).toContain('Gender');
      expect(lines[0]).toContain('Impressions');
      expect(lines[0]).toContain('Clicks');
      expect(lines[0]).toContain('Spend');
      
      // Check aggregated data (should have only 1 row for 25-34 male)
      const dataLines = lines.slice(1).filter((line: string) => line.trim().length > 0);
      expect(dataLines.length).toBe(1);
      
      // Verify aggregated values in the CSV
      const dataLine = dataLines[0];
      expect(dataLine).toContain('25-34');
      expect(dataLine).toContain('male');
      expect(dataLine).toContain('3000'); // 1000 + 2000 impressions
      expect(dataLine).toContain('150'); // 50 + 100 clicks
      expect(dataLine).toContain('$300.00'); // 100 + 200 spend
      expect(dataLine).toContain('13'); // 5 + 8 website leads
      expect(dataLine).toContain('5'); // 3 + 2 form leads
      expect(dataLine).toContain('18'); // 13 + 5 total leads
      
      // Check that campaign summary is included in result
      expect(result).toContain('Campaign Summary');
    });
  });

  describe('Cost per Lead Calculations', () => {
    it('should calculate cost per lead correctly using total leads', async () => {
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

      const result = await (agentModeService as any).formatMetricsSummary(mockData, 'test-user-id');

      // Check that campaign summary includes cost per lead
      expect(result).toContain('Campaign Summary');
      expect(result).toContain('Cost per Lead');
      expect(result).toContain('$20.00');
    });
  });
});
