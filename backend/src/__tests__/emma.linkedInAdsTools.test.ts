/**
 * Tests for LinkedIn Ads tools registered in emmaToolRegistry.
 *
 * ENG-2103 (F2) update: `call_linkedin_marketing_api`/`call_linkedin_ads_insights_api`
 * are now repointed at `emma/impl/adsApis.ts` directly (no private-method
 * blocker for these two — see that module's/tools.ts's header comments), so
 * this file's mock moved from `agentModeService` to `adsApisImpl`. `tools.ts`
 * uses `import * as adsApisImpl from './impl/adsApis'`, so the mock must be a
 * plain object of `jest.fn()`s, not a Proxy.
 */
jest.mock('../emma/impl/adsApis', () => ({
    callLinkedInMarketingApi: jest.fn(),
    callLinkedInAdsInsightsApi: jest.fn(),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as adsApisImpl from '../emma/impl/adsApis';

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
            (adsApisImpl.callLinkedInMarketingApi as jest.Mock).mockResolvedValue(mockResponse);

            const args = {
                entity_type: 'CAMPAIGN',
                action: 'CREATE',
                account_id: 'urn:li:sponsoredAccount:123',
                params: { name: 'Test Campaign' },
            };
            const context = { userId: 'user-123' };

            const result = await tool.execute(args, context);

            expect(adsApisImpl.callLinkedInMarketingApi).toHaveBeenCalledWith(
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
            (adsApisImpl.callLinkedInAdsInsightsApi as jest.Mock).mockResolvedValue(mockResponse);

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

            expect(adsApisImpl.callLinkedInAdsInsightsApi).toHaveBeenCalledWith(
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
