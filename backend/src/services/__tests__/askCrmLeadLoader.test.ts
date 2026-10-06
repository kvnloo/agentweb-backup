import { createAskCrmLeadLoader } from '../askCrmLeadLoader';
import { askCrm } from '../askCrmService';

function deps(overrides: Partial<Parameters<typeof createAskCrmLeadLoader>[0]> = {}) {
  return {
    getLeadListsForUser: jest.fn().mockResolvedValue([{ listId: 'list-1' }]),
    getLeadsByListId: jest.fn().mockResolvedValue({ items: [] }),
    getUserById: jest.fn().mockResolvedValue({ userId: 'owner', orgId: 'org-1' }),
    getUserByEmail: jest.fn().mockResolvedValue(null),
    getDealsByOwner: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('ask_crm production lead loader', () => {
  it('does not consume subscription/activity from a foreign account with the same editable lead email', async () => {
    const d = deps({
      getLeadsByListId: jest.fn().mockResolvedValue({
        items: [{ leadId: 'lead-1', listId: 'list-1', email: 'foreign@example.com', lifecycle: 'inbox' }],
      }),
      getUserByEmail: jest.fn().mockResolvedValue({
        userId: 'foreign-user',
        orgId: 'org-2',
        subscription_status: 'active',
        lastActiveAt: '2026-10-06T12:00:00.000Z',
      }),
    });
    const load = createAskCrmLeadLoader(d);
    const [lead] = await load('owner', { limit: 10 });

    expect(lead.hasUserRecord).not.toBe(true);
    expect(lead.subscriptionState).toBeNull();
    expect(lead.lastActivityAt).toBeNull();
  });

  it('deduplicates authorized same-org email lookups and applies the live account signal', async () => {
    const getUserByEmail = jest.fn().mockResolvedValue({
      userId: 'member',
      orgId: 'org-1',
      subscription_status: 'active',
      lastActiveAt: '2026-10-06T12:00:00.000Z',
    });
    const d = deps({
      getLeadsByListId: jest.fn().mockResolvedValue({
        items: [
          { leadId: 'lead-1', listId: 'list-1', email: 'Member@Example.com', lifecycle: 'inbox' },
          { leadId: 'lead-2', listId: 'list-1', email: 'member@example.com', lifecycle: 'inbox' },
        ],
      }),
      getUserByEmail,
    });
    const load = createAskCrmLeadLoader(d);
    const leads = await load('owner', { limit: 10 });

    expect(getUserByEmail).toHaveBeenCalledTimes(1);
    expect(leads.map((lead) => lead.subscriptionState)).toEqual(['active', 'active']);
  });

  it('preserves stored positive deal evidence when the bounded owner query omits that deal', async () => {
    const d = deps({
      getLeadsByListId: jest.fn().mockResolvedValue({
        items: [{
          leadId: 'lead-1',
          listId: 'list-1',
          email: 'member@example.com',
          lifecycle: 'in_deal',
          openDealStages: ['Negotiation'],
        }],
      }),
      getUserByEmail: jest.fn().mockResolvedValue({
        userId: 'member',
        orgId: 'org-1',
        subscription_status: null,
      }),
      // Successful but bounded/partial read with no matching row.
      getDealsByOwner: jest.fn().mockResolvedValue([]),
    });
    const load = createAskCrmLeadLoader(d);
    const leads = await load('owner', { limit: 10 });

    expect(leads[0].openDealStages).toEqual(['Negotiation']);
    const answer = await askCrm('which deals are closing', 'owner', {
      loadLeadsForUser: async () => leads,
      now: () => new Date('2026-10-06T13:00:00.000Z'),
    });
    expect(answer.items[0].lifecycle).toBe('in_deal');
  });

  it('uses bounded deal rows only as positive open-stage evidence and validates malformed records', async () => {
    const d = deps({
      getLeadListsForUser: jest.fn().mockResolvedValue([null, { nope: true }, { listId: 'list-1' }]),
      getLeadsByListId: jest.fn().mockResolvedValue({
        items: [null, { leadId: 7 }, { leadId: 'lead-1', email: 'lead@example.com' }],
      }),
      getDealsByOwner: jest.fn().mockResolvedValue([
        null,
        { stage: 'Won', primaryContactId: 'lead-1' },
        { stage: 'Proposal', primaryContactId: 'lead-1', contactIds: [null, 'lead-1'] },
      ]),
    });
    const load = createAskCrmLeadLoader(d);
    const leads = await load('owner', { limit: 10 });

    expect(leads).toHaveLength(1);
    expect(leads[0].openDealStages).toEqual(['Proposal']);
  });
});
