/**
 * ENG-1175 — attribution must be readable through the agent tools themselves.
 *
 * The gates cannot use a DynamoDB read. Google Pre-Launch Gate step 6.6 and the
 * Meta gate's T11 both say "read the row back with search_leads" and then assert
 * the click ID survived. Today those calls return a lead with no attribution in
 * it, so the assertion is unexecutable on Google and silently wrong on Meta —
 * which is live to customers and can BLOCK a correctly-attributed launch.
 *
 * AC2 is as important as the new fields and easier to break: every field
 * returned today must still be returned, unchanged. These tests pin the old
 * shape as well as the new.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
    getLeadById: jest.fn(),
    getLeadEngagementCount: jest.fn(),
    getLeadEngagements: jest.fn(),
  }
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

const FIRST_TOUCH = {
  timestamp: '2026-08-01T10:00:00Z',
  landingUrl: 'https://lp.test/offer?gclid=Cj0real',
  utm: { source: 'google', medium: 'cpc', campaign: 'brand' },
  clickIds: { gclid: 'Cj0real' },
};

const paidLead = {
  leadId: 'lead-paid', listId: 'list-1', email: 'paid@example.com',
  firstName: 'Paid', lastName: 'Click', company: 'Acme', title: 'CTO',
  firstTouch: FIRST_TOUCH,
  utmSource: 'google', utmMedium: 'cpc',
  clickIds: { gclid: 'Cj0real' },
  customFields: {}, icpMatch: { isMatch: true, score: 88 },
  engagementCount: 3, isEngaged: true,
};

/** Capture ran, but this visitor arrived organically — no click ID at all. */
const capturedOrganicLead = {
  leadId: 'lead-organic', listId: 'list-1', email: 'organic@example.com',
  firstName: 'Organic', lastName: 'Visitor', company: 'Beta', title: 'PM',
  firstTouch: { timestamp: '2026-08-02T11:00:00Z', landingUrl: 'https://lp.test/offer' },
  customFields: {}, engagementCount: 0, isEngaged: false,
};

/** Capture never ran for this one — imported from a CSV. */
const neverCapturedLead = {
  leadId: 'lead-csv', listId: 'list-1', email: 'csv@example.com',
  firstName: 'Csv', lastName: 'Import', company: 'Gamma', title: 'Ops',
  customFields: {}, engagementCount: 0, isEngaged: false,
};

describe('AgentModeService attribution projection (ENG-1175)', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const listId = 'list-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId, userId, name: 'List' });
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [paidLead, capturedOrganicLead, neverCapturedLead],
      lastEvaluatedKey: undefined,
    });
    (mockCrmDb.getLeadById as jest.Mock).mockResolvedValue(paidLead);
    (mockCrmDb.getLeadEngagementCount as jest.Mock).mockResolvedValue({
      total: 3, last7Days: 1, totalAllMessages: 3,
    });
    (mockCrmDb.getLeadEngagements as jest.Mock).mockResolvedValue([]);
  });

  const bySearch = async (filters: any[] = [{ field: 'email', operator: 'is_not_empty' }]) =>
    service.searchLeads(listId, filters, userId);

  describe('AC1/AC2 — searchLeads exposes the stored attribution', () => {
    it('returns firstTouch and the click ID for a paid lead', async () => {
      const res: any = await bySearch();
      const lead = res.leads.find((l: any) => l.email === 'paid@example.com');
      expect(lead.firstTouch).toEqual(FIRST_TOUCH);
      expect(lead.clickIds).toEqual({ gclid: 'Cj0real' });
      expect(lead.utmSource).toBe('google');
    });

    it('answers the gates\' actual question — did the gclid survive to the row', async () => {
      const res: any = await bySearch();
      const lead = res.leads.find((l: any) => l.email === 'paid@example.com');
      // This is Google step 6.6 / Meta T11, executable for the first time.
      expect(lead.firstTouch?.clickIds?.gclid).toBe('Cj0real');
    });

    it('does not disturb any field it returned before', async () => {
      // AC2 — existing consumers unaffected.
      const res: any = await bySearch();
      const lead = res.leads.find((l: any) => l.email === 'paid@example.com');
      expect(lead).toMatchObject({
        leadId: 'lead-paid', email: 'paid@example.com', firstName: 'Paid',
        lastName: 'Click', company: 'Acme', title: 'CTO',
        icpMatch: true, icpScore: 88, engagementCount: 3, isEngaged: true,
        customFields: {},
      });
    });
  });

  describe('AC4 — never-captured is distinguishable from captured-nothing', () => {
    it('omits firstTouch entirely for a CSV-imported lead', async () => {
      const res: any = await bySearch();
      const lead = res.leads.find((l: any) => l.email === 'csv@example.com');
      expect(lead).not.toHaveProperty('firstTouch');
      expect(lead).not.toHaveProperty('clickIds');
    });

    it('reports firstTouch but no clickIds for an organic captured lead', async () => {
      const res: any = await bySearch();
      const lead = res.leads.find((l: any) => l.email === 'organic@example.com');
      expect(lead.firstTouch).toBeDefined();
      expect(lead).not.toHaveProperty('clickIds');
    });

    it('the coverage question is answerable from the projection alone', async () => {
      // ENG-926 §F: what share of these leads were acquired by a paid click?
      const res: any = await bySearch();
      const withClick = res.leads.filter((l: any) => l.clickIds).length;
      const captured = res.leads.filter((l: any) => l.firstTouch).length;
      expect(withClick).toBe(1);
      expect(captured).toBe(2);   // NOT 1, and NOT 3 — the AC4 distinction
      expect(res.leads).toHaveLength(3);
    });
  });

  describe('AC1 — getLeadDetails matches the list path', () => {
    it('returns the same attribution shape as searchLeads', async () => {
      // Signature is (listId, leadId, userId). Asserting success FIRST and
      // unconditionally: an earlier version of this test guarded the
      // assertions behind `if (detail.success)` and passed while the call was
      // failing outright, proving nothing. A test that cannot fail is worse
      // than no test — it reports coverage it does not have.
      const detail: any = await service.getLeadDetails(listId, paidLead.leadId, userId);
      expect(detail.success).toBe(true);

      const search: any = await bySearch();
      const fromSearch = search.leads.find((l: any) => l.email === 'paid@example.com');
      expect(detail.lead.firstTouch).toEqual(fromSearch.firstTouch);
      expect(detail.lead.clickIds).toEqual(fromSearch.clickIds);
      expect(detail.lead.utmSource).toBe(fromSearch.utmSource);
    });

    it('omits attribution on the detail path too when there is none', async () => {
      (mockCrmDb.getLeadById as jest.Mock).mockResolvedValue(neverCapturedLead);
      const detail: any = await service.getLeadDetails(listId, neverCapturedLead.leadId, userId);
      expect(detail.success).toBe(true);
      expect(detail.lead).not.toHaveProperty('firstTouch');
      expect(detail.lead).not.toHaveProperty('clickIds');
    });
  });

  describe('AC6 — no cross-tenant leakage', () => {
    it('returns no attribution when the caller cannot read the list', async () => {
      (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({
        listId, userId: 'someone-else', name: 'Other tenant list',
      });
      (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);
      const res: any = await bySearch();
      const leaked = JSON.stringify(res ?? {});
      expect(leaked).not.toContain('Cj0real');
      expect(leaked).not.toContain('lp.test');
    });
  });
});
