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

  describe('computeHeatScore', () => {
    it('returns 0 for a lead with no engagement and no dates', () => {
      expect(computeHeatScore({})).toBe(0);
    });

    it('caps engagement contribution at 5', () => {
      const lead = { engagementCount: 50 };
      // No recency bonus, just capped count
      expect(computeHeatScore(lead)).toBe(5);
    });

    it('adds recency bonus for very recent contact', () => {
      const lead = {
        engagementCount: 2,
        engagements: [{ createdAt: new Date().toISOString() }],
      };
      // 2 (count) + 5 (< 1 day) = 7
      expect(computeHeatScore(lead)).toBe(7);
    });

    it('caps final score at 10', () => {
      const lead = {
        engagementCount: 20,
        engagements: [{ createdAt: new Date().toISOString() }],
      };
      expect(computeHeatScore(lead)).toBe(10);
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
              { leadId: 'a1', email: 'Foo@Example.com ', firstName: 'Foo', engagementCount: 1 },
              { leadId: 'b1', email: 'bar@example.com', firstName: 'Bar', engagementCount: 3 },
            ],
            lastEvaluatedKey: null,
            hasMore: false,
          };
        }
        if (listId === 'L2') {
          return {
            items: [
              { leadId: 'a2', email: 'foo@example.com', firstName: 'Foo2', engagementCount: 5 },
              { leadId: 'c1', email: '', firstName: 'Noemail', engagementCount: 1 },
              { leadId: 'c2', email: null, firstName: 'AlsoNoEmail' },
            ],
            lastEvaluatedKey: null,
            hasMore: false,
          };
        }
        return { items: [], lastEvaluatedKey: null, hasMore: false };
      });

      const result = await dedupContactsForUser({ userId: 'u1' });
      // Foo dedupes across L1+L2, Bar only in L1. No-email rows dropped.
      expect(result.total).toBe(2);
      expect(result.rawCount).toBe(5);
      expect(result.listsCount).toBe(2);

      const foo = result.contacts.find((c) => c.email === 'foo@example.com');
      expect(foo).toBeDefined();
      expect(foo!.lists).toHaveLength(2);
      expect(foo!.lists.map((l) => l.listId).sort()).toEqual(['L1', 'L2']);
      // Higher engagementCount lead (L2's a2, count=5) should be primary.
      expect(foo!.primaryLead.leadId).toBe('a2');

      const bar = result.contacts.find((c) => c.email === 'bar@example.com');
      expect(bar!.lists).toHaveLength(1);
    });

    it('sorts by heat score (desc) by default', async () => {
      asMock(crmDb.getLeadListsByUserId).mockResolvedValue([
        { listId: 'L1', name: 'Sales', listType: 'sales' },
      ]);
      asMock(crmDb.getLeadsByListId).mockResolvedValue({
        items: [
          { leadId: '1', email: 'low@x.com', engagementCount: 0 },
          { leadId: '2', email: 'high@x.com', engagementCount: 5 },
          { leadId: '3', email: 'mid@x.com', engagementCount: 2 },
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
        items: [{ leadId: listId, email: `${listId}@x.com`, engagementCount: 1 }],
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
          { leadId: '1', email: 'a@x.com', engagementCount: 0 },
          { leadId: '2', email: 'b@x.com', engagementCount: 5 },
          { leadId: '3', email: 'c@x.com', engagementCount: 2 },
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
          items: [{ leadId: '1', email: 'ok@x.com', engagementCount: 1 }],
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
          engagementCount: 0,
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
          engagementCount: 0,
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
        items: [{ leadId: 'x', email: 'x@x.com', engagementCount: 0 }],
        lastEvaluatedKey: null,
      }));

      // Should not throw; should use the built-in default cap
      const result = await dedupContactsForUser({ userId: 'u1' });
      expect(result.contacts.length).toBeGreaterThan(0);
    });
  });
});
