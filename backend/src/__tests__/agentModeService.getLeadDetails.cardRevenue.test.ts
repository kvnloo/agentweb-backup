/**
 * ENG-1388: getLeadDetails() is an Emma tool backing get_lead_details, reached
 * via canOrgMemberAccessList — the normal org-sharing check, with no Enigma
 * allowlist awareness. Card revenue (Enigma, internal-use-only) must be
 * stripped from both customFields and enrichmentMetadata when the CALLER
 * (not the list owner) isn't Enigma-allowlisted, the same boundary already
 * enforced on the customer-portal REST path (sanitizeLeadForResponse).
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadById: jest.fn(),
    getLeadEngagementCount: jest.fn(),
    getLeadEngagements: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
}));

jest.mock('../services/enigmaCardRevenueEnrichment', () => ({
  isEnigmaEnrichmentEnabledForUser: jest.fn().mockReturnValue(false),
}));

// Minimal stubs for transitive dependencies pulled in by agentModeService
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService', () => ({ gmailService: { sendEmail: jest.fn() } }));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';
import { isEnigmaEnrichmentEnabledForUser } from '../services/enigmaCardRevenueEnrichment';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe('AgentModeService.getLeadDetails – card revenue display boundary (ENG-1388)', () => {
  let service: AgentModeService;
  const listId = 'list-aaa';
  const leadId = 'lead-zzz';
  const mockList = { listId, userId: 'list-owner', name: 'Shared List' };

  const leadWithCardRevenue = {
    leadId,
    listId,
    company: 'Acme',
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
    mockCrmDb.canOrgMemberAccessList.mockResolvedValue(true);
    mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
    mockCrmDb.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 } as any);
    mockCrmDb.getLeadEngagements.mockResolvedValue({ engagements: [] } as any);
    mockCrmDb.getLeadById.mockResolvedValue(leadWithCardRevenue as any);
  });

  it('strips card revenue from customFields and enrichmentMetadata for a non-allowlisted org-mate', async () => {
    (isEnigmaEnrichmentEnabledForUser as jest.Mock).mockReturnValue(false);
    const result = await service.getLeadDetails(listId, leadId, 'org-mate-not-allowlisted');

    expect(result.success).toBe(true);
    expect(result.lead.customFields).not.toHaveProperty('card_revenue_12m');
    expect(result.lead.customFields.industry).toBe('Software');
    expect(result.lead.enrichmentMetadata).not.toHaveProperty('card_revenue_12m');
    expect(result.lead.enrichmentMetadata.industry).toBeDefined();
  });

  it('keeps card revenue for an allowlisted caller, even on a list owned by someone else', async () => {
    (isEnigmaEnrichmentEnabledForUser as jest.Mock).mockReturnValue(true);
    const result = await service.getLeadDetails(listId, leadId, 'allowlisted-admin');

    expect(result.lead.customFields.card_revenue_12m).toBe('41999657');
    expect(result.lead.enrichmentMetadata.card_revenue_12m).toBeDefined();
  });

  it('does not mutate the underlying lead object returned by the db layer', async () => {
    (isEnigmaEnrichmentEnabledForUser as jest.Mock).mockReturnValue(false);
    await service.getLeadDetails(listId, leadId, 'org-mate-not-allowlisted');
    expect(leadWithCardRevenue.customFields.card_revenue_12m).toBe('41999657');
  });
});
