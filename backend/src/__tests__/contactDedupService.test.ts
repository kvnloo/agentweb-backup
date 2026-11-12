/**
 * contactDedupService unit tests.
 *
 * Covers:
 *  - Dedupe by lowercased + trimmed email
 *  - Missing/blank emails are dropped
 *  - Multi-list membership merges correctly
 *  - Heat score picks highest-engagement lead as primary
 *  - Sorting (heat default, recent alt)
 *  - listType + listIds filters
 *  - Individual list failures don't kill the call
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
}));

import { crmDb } from '../services/db';
import {
  computeHeatScore,
  dedupContactsForUser,
} from '../services/contactDedupService';

const asMock = (fn: any) => fn as jest.Mock;

describe('contactDedupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** n genuine (old, no recency bonus) replies: heat 0 / 5 / 6 / 7. */
  const replies = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      eventType: 'email.received',
      createdAt: '2020-01-01T00:00:00.000Z',
      eventData: { messageId: `m${i}`, text: 'Yes, interested.' },
    }));

  describe('computeHeatScore', () => {
    const now = new Date().toISOString();
    it('returns 0 for a lead with no engagement and no dates', () => {
      expect(computeHeatScore({})).toBe(0);
    });

    it('does not score outbound volume (engagementCount = sends)', () => {
      expect(computeHeatScore({ engagementCount: 50 })).toBe(0);
    });

    it('does not score a freshly created lead with no engagement', () => {
      expect(computeHeatScore({ createdAt: now, engagements: [] })).toBe(0);
    });

    it('does not score sends and status changes, however recent', () => {
      const lead = {
        engagements: [
          { eventType: 'custom.email_sent', createdAt: now },
          { eventType: 'status.changed', createdAt: now, eventData: { from: 'new', to: 'contacted' } },
          { eventType: 'linkedin.invite.sent', createdAt: now },
        ],
      };
      expect(computeHeatScore(lead)).toBe(0);
    });

    it('scores a recent genuine reply as Hot', () => {
      const lead = { engagements: [{ eventType: 'email.received', createdAt: now, eventData: { subject: 'Re: intro', text: 'Yes, happy to chat Thursday.' } }] };
      expect(computeHeatScore(lead)).toBe(8);
    });

    it('does not score an out-of-office auto-reply', () => {
      const lead = { engagements: [{ eventType: 'custom.email_reply_received', createdAt: now, eventData: { subject: 'Automatic reply: Nov 17', notes: 'Auto-reply: traveling this week' } }] };
      expect(computeHeatScore(lead)).toBe(0);
    });
  });

  describe('dedupContactsForUser', () => {
    it('throws when userId is missing', async () => {
      await expect(dedupContactsForUser({ userId: '' })).rejects.toThrow(/userId/);
    });

    it('dedupes by lowercased trimmed email across multiple lists', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'Sales A', listType: 'sales' },
        { listId: 'L2', name: 'Sales B', listType: 'sales' },
      ]);

      asMock(crmDb.getLeadsByListId).mockImplementation(async (listId: string) => {
        if (listId === 'L1') {
          return {
            items: [
              { leadId: 'a1', email: 'Foo@Example.com ', firstName: 'Foo', engagements: replies(1) },
              { leadId: 'b1', email: 'bar@example.com', firstName: 'Bar', engagements: replies(3) },
            ],
            lastEvaluatedKey: null,
            hasMore: false,
          };
        }
        if (listId === 'L2') {
          return {
            items: [
              { leadId: 'a2', email: 'foo@example.com', firstName: 'Foo2', engagements: replies(5) },
              { leadId: 'c1', email: '', firstName: 'Noemail', engagements: replies(1) },
              { leadId: 'c2', email: null, firstName: 'AlsoNoEmail' },
            ],
            lastEvaluatedKey: null,
            hasMore: false,
          };
        }
        return { items: [], lastEvaluatedKey: null, hasMore: false };
      });

      const result = await dedupContactsForUser({ userId: 'u1' });
      // Foo dedupes across L1+L2, Bar only in L1. ENG-2082: the two address-less rows are
      // INCLUDED now rather than counted and dropped — they are real, contactable leads,
      // and dropping them is why a customer could watch a capture land and not find it in
      // the Contacts tab. They cannot collapse together: neither has a phone, so each
      // falls back to its own lead key.
      expect(result.total).toBe(4);
      expect(result.rawCount).toBe(5);
      expect(result.noEmailCount).toBe(2);
      expect(result.listsCount).toBe(2);
      expect(new Set(result.contacts.map((c) => c.dedupKey)).size).toBe(4);

      const foo = result.contacts.find((c) => c.email === 'foo@example.com');
      expect(foo).toBeDefined();
      expect(foo!.lists).toHaveLength(2);
      expect(foo!.lists.map((l) => l.listId).sort()).toEqual(['L1', 'L2']);
      // More genuine replies (L2's a2, count=5) should be primary.
      expect(foo!.primaryLead.leadId).toBe('a2');

      const bar = result.contacts.find((c) => c.email === 'bar@example.com');
      expect(bar!.lists).toHaveLength(1);
    });


    it('ENG-2082: phone-only leads are contacts, and two of them never collapse into one', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([{ listId: 'L1', name: 'Inbound', listType: 'sales' }]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [
          { leadId: 'p1', phone: '2125559876', firstName: 'Cal' },
          { leadId: 'p2', phone: '2125550001', firstName: 'Dee' },
          // same human, same number in a different format -> ONE contact
          { leadId: 'p3', phone: '+1 (212) 555-9876', firstName: 'Cal' },
          { leadId: 'n1' },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await dedupContactsForUser({ userId: 'u1' });

      expect(result.rawCount).toBe(4);
      expect(result.noEmailCount).toBe(4);
      // Cal's two rows merge on the normalized number; Dee and the bare row stay separate.
      expect(result.total).toBe(3);
      const keys = result.contacts.map((c) => c.dedupKey).sort();
      expect(keys).toEqual(['lead:L1/n1', 'phone:2125550001', 'phone:2125559876']);
      // and they are not all sharing one empty-email identity
      expect(result.contacts.every((c) => c.email === '')).toBe(true);
    });

    // The mirror of the portal's floor. `+1` and `1` both reduce to `1`, so without it every
    // lead across the account carrying only a country code collapsed into ONE contact — the
    // rest disappear and their list memberships are grafted onto the survivor. A merge is
    // destructive in a way a split is not.
    it('does NOT collapse two people whose phones are only a country code', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([{ listId: 'L1', name: 'Inbound', listType: 'sales' }]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [
          { leadId: 'a', phone: '+1', firstName: 'Ann', lastName: 'Alpha' },
          { leadId: 'b', phone: '1', firstName: 'Ben', lastName: 'Beta' },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await dedupContactsForUser({ userId: 'u1' });

      expect(result.total).toBe(2);
      const keys = result.contacts.map((c) => c.dedupKey).sort();
      expect(keys).toEqual(['lead:L1/a', 'lead:L1/b']);
      expect(keys).not.toContain('phone:1');
    });

    it('still merges two rows that share a REAL number', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([{ listId: 'L1', name: 'Inbound', listType: 'sales' }]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [
          { leadId: 'a', phone: '(212) 555-0147' },
          { leadId: 'b', phone: '+1 212 555 0147' },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await dedupContactsForUser({ userId: 'u1' });
      expect(result.total).toBe(1);
      expect(result.contacts[0].dedupKey).toBe('phone:2125550147');
    });

    it('ENG-2082: a phone-only contact is named by its number, not left blank', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([{ listId: 'L1', name: 'Inbound', listType: 'sales' }]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [{ leadId: 'p1', phone: '2125559876' }],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await dedupContactsForUser({ userId: 'u1' });
      expect(result.contacts[0].name).toBe('2125559876');
    });

    it('sorts by heat score (desc) by default', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'Sales', listType: 'sales' },
      ]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [
          { leadId: '1', email: 'low@x.com', engagements: replies(0) },
          { leadId: '2', email: 'high@x.com', engagements: replies(5) },
          { leadId: '3', email: 'mid@x.com', engagements: replies(2) },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await dedupContactsForUser({ userId: 'u1' });
      expect(result.contacts.map((c) => c.email)).toEqual([
        'high@x.com',
        'mid@x.com',
        'low@x.com',
      ]);
    });

    it('applies listType filter', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'Sales', listType: 'sales' },
        { listId: 'L2', name: 'Customers', listType: 'customers' },
      ]);
      asMock(crmDb.getLeadsByListId).mockImplementation(async (listId: string) => ({
        items: [{ leadId: listId, email: `${listId}@x.com`, engagements: replies(1) }],
        lastEvaluatedKey: null,
        hasMore: false,
      }));

      const result = await dedupContactsForUser({ userId: 'u1', listType: 'sales' });
      expect(result.listsCount).toBe(1);
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].email).toBe('l1@x.com');
    });

    it('applies limit after sorting', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'Sales', listType: 'sales' },
      ]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [
          { leadId: '1', email: 'a@x.com', engagements: replies(0) },
          { leadId: '2', email: 'b@x.com', engagements: replies(5) },
          { leadId: '3', email: 'c@x.com', engagements: replies(2) },
        ],
        lastEvaluatedKey: null,
        hasMore: false,
      });

      const result = await dedupContactsForUser({ userId: 'u1', limit: 2 });
      expect(result.total).toBe(3);
      expect(result.contacts).toHaveLength(2);
      expect(result.contacts[0].email).toBe('b@x.com');
      expect(result.contacts[1].email).toBe('c@x.com');
    });

    it('handles individual list fetch failures gracefully', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'Good', listType: 'sales' },
        { listId: 'L2', name: 'Bad', listType: 'sales' },
      ]);
      asMock(crmDb.getLeadsByListId).mockImplementation(async (listId: string) => {
        if (listId === 'L2') {
          throw new Error('boom');
        }
        return {
          items: [{ leadId: '1', email: 'ok@x.com', engagements: replies(1) }],
          lastEvaluatedKey: null,
          hasMore: false,
        };
      });

      const result = await dedupContactsForUser({ userId: 'u1' });
      expect(result.total).toBe(1);
      expect(result.contacts[0].email).toBe('ok@x.com');
    });

    it('respects maxRawLeads cap and stops fetching pages once the cap is hit', async () => {
      // Simulate a large list that paginates: each page returns 10 leads with a nextKey
      // until stopped. With maxRawLeads=15 across 1 list, it should stop after 2 pages (20 raw
      // leads would exceed the cap, so 15 leads are allowed through).
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'BIG', name: 'Huge List', listType: 'sales' },
      ]);

      let callCount = 0;
      asMock(crmDb.getLeadsByListId).mockImplementation(async (_listId: string, pageSize: number) => {
        callCount += 1;
        const items = Array.from({ length: pageSize }, (_, i) => ({
          leadId: `lead-${callCount}-${i}`,
          email: `lead-${callCount}-${i}@x.com`,
          engagements: replies(0),
        }));
        return {
          items,
          // Always indicate more pages available
          lastEvaluatedKey: { pk: `page${callCount}` },
        };
      });

      const result = await dedupContactsForUser({ userId: 'u1', maxRawLeads: 15 });
      // Should have fetched at most ceil(15/500) pages, so 1 page of 500 leads
      // but capped at 15 unique contacts
      expect(result.contacts.length).toBeLessThanOrEqual(15);
      expect(result.rawCount).toBeLessThanOrEqual(15);
      // Should NOT have fetched indefinitely
      expect(callCount).toBeLessThanOrEqual(3);
    });

    it('distributes maxRawLeads evenly across multiple large lists', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'List1', listType: 'sales' },
        { listId: 'L2', name: 'List2', listType: 'sales' },
        { listId: 'L3', name: 'List3', listType: 'sales' },
        { listId: 'L4', name: 'List4', listType: 'sales' },
      ]);

      asMock(crmDb.getLeadsByListId).mockImplementation(async (listId: string, pageSize: number) => {
        const items = Array.from({ length: pageSize }, (_, i) => ({
          leadId: `${listId}-lead-${i}`,
          email: `${listId}-lead-${i}@x.com`,
          engagements: replies(0),
        }));
        return { items, lastEvaluatedKey: null };
      });

      const result = await dedupContactsForUser({ userId: 'u1', maxRawLeads: 100 });
      // With 4 lists and 100 max raw leads, each list gets ~25 leads
      expect(result.rawCount).toBeLessThanOrEqual(100);
    });

    it('falls back to default cap when maxRawLeads is not specified', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'List1', listType: 'sales' },
      ]);

      asMock(crmDb.getLeadsByListId).mockImplementation(async () => ({
        items: [{ leadId: 'x', email: 'x@x.com', engagements: replies(0) }],
        lastEvaluatedKey: null,
      }));

      // Should not throw; should use the built-in default cap
      const result = await dedupContactsForUser({ userId: 'u1' });
      expect(result.contacts.length).toBeGreaterThan(0);
    });
  });
});
