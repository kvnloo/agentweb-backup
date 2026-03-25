/**
 * Tests for LinkedIn Ads tools registered in emmaToolRegistry.
 */

// We mock agentModeService before importing tools.ts to ensure it gets the mocked version
jest.mock('../services/agentModeService', () => ({
    agentModeService: {
        callLinkedInMarketingApi: jest.fn(),
        callLinkedInAdsInsightsApi: jest.fn(),
    },
}));

import { emmaToolRegistry } from '../emma/registry';
import { agentModeService } from '../services/agentModeService';

// Import tools.ts to ensure tools are registered
import '../emma/tools';

describe('LinkedIn Ads Emma Tools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('call_linkedin_marketing_api', () => {
        const toolName = 'call_linkedin_marketing_api';

        it('should be registered in emmaToolRegistry', () => {
            const tool = emmaToolRegistry.getTool(toolName);
            expect(tool).toBeDefined();
            expect(tool?.definition.name).toBe(toolName);
        });

        it('should delegate execution to agentModeService.callLinkedInMarketingApi', async () => {
            const tool = emmaToolRegistry.getTool(toolName);
            if (!tool) throw new Error(`Tool ${toolName} not found`);

            const mockResponse = { success: true, message: 'Campaign created' };
            (agentModeService.callLinkedInMarketingApi as jest.Mock).mockResolvedValue(mockResponse);

            const args = {
                entity_type: 'CAMPAIGN',
                action: 'CREATE',
                account_id: 'urn:li:sponsoredAccount:123',
                params: { name: 'Test Campaign' },
            };
            const context = { userId: 'user-123' };

            const result = await tool.execute(args, context);

            expect(agentModeService.callLinkedInMarketingApi).toHaveBeenCalledWith(
                'user-123',
                'CAMPAIGN',
                'CREATE',
                'urn:li:sponsoredAccount:123',
                { name: 'Test Campaign' }
            );
            expect(result).toEqual(mockResponse);
        });
    });

    describe('call_linkedin_ads_insights_api', () => {
        const toolName = 'call_linkedin_ads_insights_api';

        it('should be registered in emmaToolRegistry', () => {
            const tool = emmaToolRegistry.getTool(toolName);
            expect(tool).toBeDefined();
            expect(tool?.definition.name).toBe(toolName);
        });

        it('should parse arguments and delegate to agentModeService.callLinkedInAdsInsightsApi', async () => {
            const tool = emmaToolRegistry.getTool(toolName);
            if (!tool) throw new Error(`Tool ${toolName} not found`);

            const mockResponse = { success: true, analytics: [] };
            (agentModeService.callLinkedInAdsInsightsApi as jest.Mock).mockResolvedValue(mockResponse);

            const args = {
                account_id: 'urn:li:sponsoredAccount:123',
                pivot: 'CAMPAIGN',
                dateRange: { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 1, day: 31 } },
                timeGranularity: 'DAILY',
                fields: ['impressions', 'clicks'],
                campaigns: ['camp-1', 'camp-2'],
            };
            const context = { userId: 'user-123' };

            const result = await tool.execute(args, context);

            expect(agentModeService.callLinkedInAdsInsightsApi).toHaveBeenCalledWith(
                'user-123',
                'urn:li:sponsoredAccount:123',
                {
                    pivot: 'CAMPAIGN',
                    dateRange: { start: { year: 2024, month: 1, day: 1 }, end: { year: 2024, month: 1, day: 31 } },
                    timeGranularity: 'DAILY',
                    fields: ['impressions', 'clicks'],
                    campaigns: ['camp-1', 'camp-2'],
                    creatives: undefined,
                }
            );
            expect(result).toEqual(mockResponse);
        });
    });
});
