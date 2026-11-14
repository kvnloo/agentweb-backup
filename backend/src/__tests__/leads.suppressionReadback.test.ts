jest.mock('../services/db', () => ({ crmDb: {
  getLeadListById: jest.fn(), canOrgMemberAccessList: jest.fn(),
  getLeadById: jest.fn(), getLeadsByListId: jest.fn(),
  getLeadEngagementCount: jest.fn(), getLeadEngagements: jest.fn(), updateLead: jest.fn(),
} }));
jest.mock('../services/crmAccessControl', () => ({ canDestructiveCrmList: jest.fn().mockResolvedValue(true) }));
import { getLeadDetails, getLeads, searchLeads, setLeadContactStatus } from '../emma/impl/leads';
import { crmDb } from '../services/db';
const db = crmDb as any;
const readers = {
  detail: async () => (await getLeadDetails('list', 'lead', 'user')).lead,
  list: async () => (await getLeads('list', 'user')).leads?.[0],
  search: async () => (await searchLeads('list', [], 'user')).leads?.[0],
};
let lead: any;
beforeEach(() => {
  jest.clearAllMocks();
  lead = { leadId: 'lead', listId: 'list', email: 'a@example.com', updatedAt: 'unchanged' };
  db.getLeadListById.mockResolvedValue({ listId: 'list', name: 'List' });
  db.canOrgMemberAccessList.mockResolvedValue(true);
  db.getLeadById.mockImplementation(async () => lead);
  db.getLeadsByListId.mockImplementation(async () => ({ items: [lead] }));
  db.getLeadEngagementCount.mockResolvedValue({ total: 0, last7Days: 0, totalAllMessages: 0 });
  db.getLeadEngagements.mockResolvedValue({ engagements: [] });
  db.updateLead.mockImplementation(async (_list: string, _id: string, updates: any) => Object.assign(lead, updates));
});
for (const [name, read] of Object.entries(readers)) {
  describe(name, () => {
    it.each(['active', 'unsubscribed', 'do-not-contact'])('preserves persisted %s suppression evidence', async status => {
      Object.assign(lead, { contactStatus: status, contactStatusReason: 'requested-removal',
        contactStatusNote: 'Exact request', contactStatusUpdatedAt: '2026-11-14T00:00:00Z',
        contactStatusUpdatedBy: 'user', unsubscribedFromGroupEmail: status !== 'active',
        unsubscribedFromGroupEmailAt: '2026-11-14T00:00:00Z' });
      const { leadId, listId, email, updatedAt, ...suppression } = lead;
      expect(await read()).toMatchObject(suppression);
    });
    it('does not infer active or false suppression from absent fields', async () => {
      const result = await read();
      expect(result).not.toHaveProperty('contactStatus');
      expect(result).not.toHaveProperty('unsubscribedFromGroupEmail');
    });
    it('exposes exact status after a successful write, not just updatedAt', async () => {
      const write = await setLeadContactStatus('list', ['lead'], 'unsubscribed', 'requested-removal', 'Exact request', 'user');
      expect(write).toMatchObject({ success: true, updated: 1, failed: 0 });
      expect(await read()).toMatchObject({ contactStatus: 'unsubscribed', unsubscribedFromGroupEmail: true,
        contactStatusReason: 'requested-removal', contactStatusNote: 'Exact request', contactStatusUpdatedBy: 'user' });
    });
    it('returns no lead data for unauthorized list readers', async () => {
      db.canOrgMemberAccessList.mockResolvedValue(false);
      expect(await read()).toBeUndefined();
      expect(db.getLeadById).not.toHaveBeenCalled();
      expect(db.getLeadsByListId).not.toHaveBeenCalled();
    });
  });
}
