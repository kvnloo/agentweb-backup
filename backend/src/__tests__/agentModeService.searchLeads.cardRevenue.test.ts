/**
 * ENG-1388: searchLeads() is an Emma tool backing search_leads, reached via
 * canOrgMemberAccessList — the normal org-sharing check, with no Enigma
 * allowlist awareness. Card revenue (Enigma, internal-use-only) must be
 * stripped from both customFields and enrichmentMetadata, per lead, when the
 * CALLER isn't Enigma-allowlisted — same boundary already enforced on the
 * customer-portal REST path (sanitizeLeadForResponse), now at scale (many
 * leads per call, potentially across lists in multi-list mode).
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
}));

jest.mock('../services/enigmaCardRevenueEnrichment', () => ({
  isEnigmaEnrichmentEnabledForUser: jest.fn().mockReturnValue(false),
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';
import { isEnigmaEnrichmentEnabledForUser } from '../services/enigmaCardRevenueEnrichment';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe('AgentModeService.searchLeads — card revenue display boundary (ENG-1388)', () => {
  let service: AgentModeService;
  const listId = 'list-1';

  const leadWithCardRevenue = {
    leadId: 'lead-1',
    listId,
    email: 'lead1@example.com',
    company: 'Acme',
    isICP: true,
    customFields: { card_revenue_12m: '41999657', industry: 'Software' },
    enrichmentMetadata: {
      card_revenue_12m: { source: 'api', provider: 'enigma', confidence: 'medium', enrichedAt: '2026-06-22T00:00:00.000Z' },
      industry: { source: 'api', provider: 'apollo', confidence: 'high', enrichedAt: '2026-06-22T00:00:00.000Z' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (isEnigmaEnrichmentEnabledForUser as jest.Mock).mockReturnValue(false);
    service = new AgentModeService();
    mockCrmDb.getLeadListById.mockResolvedValue({ listId, userId: 'list-owner', name: 'List' } as any);
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(true);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [leadWithCardRevenue], lastEvaluatedKey: undefined } as any);
  });

  it('strips card revenue from customFields and enrichmentMetadata for a non-allowlisted org-mate', async () => {
    (isEnigmaEnrichmentEnabledForUser as jest.Mock).mockReturnValue(false);
    const res = await service.searchLeads(
      listId, [{ field: 'company', operator: 'equals', value: 'Acme' }], 'org-mate-not-allowlisted',
    );
    expect(res.success).toBe(true);
    expect(res.leads).toHaveLength(1);
    expect(res.leads[0].customFields).not.toHaveProperty('card_revenue_12m');
    expect(res.leads[0].customFields.industry).toBe('Software');
    expect(res.leads[0].enrichmentMetadata).not.toHaveProperty('card_revenue_12m');
    expect(res.leads[0].enrichmentMetadata.industry).toBeDefined();
  });

  it('keeps card revenue for an allowlisted caller', async () => {
    (isEnigmaEnrichmentEnabledForUser as jest.Mock).mockReturnValue(true);
    const res = await service.searchLeads(
      listId, [{ field: 'company', operator: 'equals', value: 'Acme' }], 'allowlisted-admin',
    );
    expect(res.leads[0].customFields.card_revenue_12m).toBe('41999657');
    expect(res.leads[0].enrichmentMetadata.card_revenue_12m).toBeDefined();
  });
});
