/**
 * ENG-1218 — every top-level lead field must resolve in BOTH filter resolvers.
 *
 * The filter engine resolves a field name three ways: a known standard field, a
 * dot path, or — failing both — `lead.customFields[field]`. An unknown field
 * therefore does not error. It resolves to a custom field that does not exist,
 * so `is_empty` matches EVERY lead and `is_not_empty` matches none.
 *
 * `searchLeads` and `deleteLeadsByFilter` each kept their own hand-maintained
 * copy of the standard-field list, and both had drifted: `createLead` accepts
 * ~40 top-level fields, the resolvers knew 14. Measured before this fix, on two
 * leads where A has every field and B has none:
 *
 *   lifecycle / domain / priority / heatScore / companyLinkedin /
 *   utmSource / accountOwnerUserId / contactStatus  -> "would delete 2 of 2"
 *
 * "Delete the leads with no lifecycle set" selected the entire list. The
 * two-phase confirm gate is the only thing between that and data loss, and its
 * preview shows the wrong count as if it were right.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  }
}));
jest.mock('../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
  CRM_EDITOR_REQUIRED_MESSAGE: 'editor required',
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';
import { LEAD_STANDARD_FILTER_FIELDS } from '../utils/leadSchema';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

/** The fields the resolvers were blind to. Each was a live delete hazard. */
const PREVIOUSLY_BLIND = [
  'companyLinkedin', 'selectedSenderId', 'contactStatus', 'contactStatusReason',
  'contactStatusNote', 'contactStatusUpdatedBy', 'domain', 'accountOwnerUserId',
  'priority', 'expectedClose', 'closedDate', 'heatScore', 'healthScore',
  'lifecycle', 'role', 'firstTouch', 'lastTouch', 'utmSource', 'utmMedium',
];

/** Lead A has every field populated. */
const populated: any = {
  leadId: 'A', listId: 'l1', email: 'a@x.com', firstName: 'A', lastName: 'One',
  phone: '111', company: 'Acme', title: 'CTO', notes: 'n', linkedin: 'li/a',
  companyLinkedin: 'li/company/acme', status: 'active', dealValue: 100,
  dealCurrency: 'USD', selectedSenderId: 's1', contactStatus: 'contacted',
  contactStatusReason: 'r', contactStatusNote: 'note', contactStatusUpdatedBy: 'u',
  domain: 'acme.com', accountOwnerUserId: 'u9', pocEmails: ['p@acme.com'],
  priority: 'High', expectedClose: '2026-09-01', closedDate: '2026-09-02',
  heatScore: 90, healthScore: 80, lifecycle: 'in_deal', role: 'KDM',
  isPrimary: true, firstTouch: { landingUrl: 'https://x/1' },
  lastTouch: { landingUrl: 'https://x/2' }, utmSource: 'google',
  utmMedium: 'cpc', clickIds: { gclid: 'g1' },
  createdAt: '2026-01-01', updatedAt: '2026-01-02', customFields: {},
};

/** Lead B has none of them. */
const bare: any = { leadId: 'B', listId: 'l1', email: 'b@x.com', customFields: {} };

describe('CRM filter field drift (ENG-1218)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'l1', userId: 'u1', name: 'L' });
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
      items: [populated, bare], lastEvaluatedKey: undefined,
    });
  });

  const search = (field: string, operator: string) =>
    service.searchLeads('l1', [{ field, operator }], 'u1') as Promise<any>;
  const destructive = (field: string, operator: string) =>
    service.deleteLeadsByFilter('l1', [{ field, operator }], 'u1') as Promise<any>;

  describe('AC2 — the previously blind fields resolve correctly', () => {
    it.each(PREVIOUSLY_BLIND)('is_empty on %s selects only the lead missing it', async (field) => {
      const res = await search(field, 'is_empty');
      expect(res.leads.map((l: any) => l.leadId)).toEqual(['B']);
    });

    it.each(PREVIOUSLY_BLIND)('is_not_empty on %s selects only the lead that has it', async (field) => {
      const res = await search(field, 'is_not_empty');
      expect(res.leads.map((l: any) => l.leadId)).toEqual(['A']);
    });
  });

  describe('the destructive path — where this became data loss', () => {
    it.each(PREVIOUSLY_BLIND)('deleting "no %s" never selects the lead that has one', async (field) => {
      const res = await destructive(field, 'is_empty');
      expect(res.matchCount).toBe(1);
      expect((res.sampleLeads ?? []).map((l: any) => l.leadId)).not.toContain('A');
    });

    it('previews rather than deletes — nothing here is destructive', async () => {
      const res = await destructive('lifecycle', 'is_empty');
      expect(res.requiresConfirmation).toBe(true);
      expect(res.deletedCount).toBeUndefined();
    });
  });

  describe('AC4 — the two resolvers cannot diverge again', () => {
    it.each([...LEAD_STANDARD_FILTER_FIELDS])(
      'search and delete agree on %s',
      async (field) => {
        // This is the regression that matters. ENG-1176 fixed `clickIds` in
        // searchLeads and missed deleteLeadsByFilter entirely, because the two
        // lists were separate. Any future field added to one and not the other
        // fails here.
        const [s, d] = await Promise.all([search(field, 'is_empty'), destructive(field, 'is_empty')]);
        expect(d.matchCount).toBe(s.leads.length);
      },
    );
  });

  describe('AC3/AC5 — custom fields still behave', () => {
    it('a genuine custom field still filters', async () => {
      const withCustom = { ...bare, leadId: 'C', customFields: { industry: 'saas' } };
      (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [populated, withCustom], lastEvaluatedKey: undefined,
      });
      const res = await search('industry', 'is_not_empty');
      expect(res.leads.map((l: any) => l.leadId)).toEqual(['C']);
    });

    it('a custom field named like a standard one is never mistaken for it', async () => {
      const decoy = { ...bare, leadId: 'D', customFields: { lifecycle: 'not the real thing' } };
      (mockCrmDb.getLeadsByListId as jest.Mock).mockResolvedValue({
        items: [populated, decoy], lastEvaluatedKey: undefined,
      });
      const res = await search('lifecycle', 'is_not_empty');
      expect(res.leads.map((l: any) => l.leadId)).toEqual(['A']);
    });
  });
});
