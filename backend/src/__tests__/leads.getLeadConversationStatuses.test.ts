/**
 * ENG-2811 — batched read-only conversation-status audit. Proves one call
 * covers many leads with a constant query set (no per-lead Unipile calls),
 * per-item not_found for ids outside the list (cross-tenant safe), per-item
 * partial failures, and cursor pagination.
 */
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadById: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByEmailDomain: jest.fn() },
}));
jest.mock('../services/unipileConnectionsDb', () => ({
  getAllConnectionsByAccount: jest.fn(),
  normalizeLinkedInUrl: (url: string) => {
    let u = url.trim().toLowerCase();
    if (!u.endsWith('/')) u += '/';
    return u;
  },
}));

import { getLeadConversationStatuses } from '../emma/impl/leads';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import * as conns from '../services/unipileConnectionsDb';

const db = crmDb as any;
const listId = 'list-1';
const userId = 'user-1';
const CONNECTED = new Date('2026-10-01T00:00:00Z').getTime();

const leadA = { leadId: 'a', listId, firstName: 'Anna', lastName: 'A', company: 'Acme', linkedin: 'https://linkedin.com/in/anna/', email: 'anna@acme.com' };
const leadB = { leadId: 'b', listId, firstName: 'Ben', linkedin: 'https://linkedin.com/in/ben/' };

beforeEach(() => {
  jest.clearAllMocks();
  db.getLeadListById.mockResolvedValue({ listId, name: 'Outreach', linkedInAccountId: 'acc-1' });
  db.canOrgMemberAccessList.mockResolvedValue(true);
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId, emailDomain: 'me.com' });
  (conns.getAllConnectionsByAccount as jest.Mock).mockResolvedValue([
    { publicProfileUrl: 'https://linkedin.com/in/anna/', connectedAt: CONNECTED },
  ]);
  (emailEventsDb.getEventsByEmailDomain as jest.Mock).mockImplementation(async (d: string) =>
    d === `linkedin-${listId}`
      ? [
          { leadEmail: 'https://linkedin.com/in/anna/', eventType: 'linkedin.message_sent', createdAt: '2026-10-02T00:00:00Z' },
          { leadEmail: 'https://linkedin.com/in/anna/', eventType: 'linkedin.message_received', createdAt: '2026-10-03T00:00:00Z' },
        ]
      : [],
  );
});

describe('getLeadConversationStatuses', () => {
  it('returns all requested leads in one call with compact status rows', async () => {
    db.getLeadById.mockImplementation(async (_l: string, id: string) => ({ a: leadA, b: leadB } as any)[id] ?? null);
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: ['a', 'b'] });
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
    const a = r.leads.find((x: any) => x.leadId === 'a');
    expect(a).toMatchObject({
      status: 'ok', name: 'Anna A', connectionState: 'connected', lastMessageChannel: 'linkedin',
      lastMessageDirection: 'inbound', replyState: 'replied_awaiting_us', lastMessageAt: '2026-10-03T00:00:00.000Z',
    });
    expect(r.leads.find((x: any) => x.leadId === 'b')).toMatchObject({ connectionState: 'not_connected', replyState: 'no_messages' });
    // constant query set: one connections read, two event reads, regardless of lead count
    expect(conns.getAllConnectionsByAccount).toHaveBeenCalledTimes(1);
    expect(emailEventsDb.getEventsByEmailDomain).toHaveBeenCalledTimes(2);
  });

  it('reports ids outside the accessible list as not_found without data (cross-tenant)', async () => {
    db.getLeadById.mockImplementation(async (_l: string, id: string) =>
      id === 'a' ? leadA : id === 'foreign' ? { ...leadB, leadId: 'foreign', listId: 'other-tenant-list' } : null);
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: ['a', 'foreign', 'missing'] });
    expect(db.getLeadById).toHaveBeenCalledWith(listId, 'foreign');
    expect(r.leads.find((x: any) => x.leadId === 'foreign')).toEqual({ leadId: 'foreign', status: 'not_found' });
    expect(r.leads.find((x: any) => x.leadId === 'missing')).toEqual({ leadId: 'missing', status: 'not_found' });
    expect(r.notFound).toBe(2);
  });

  it('reports per-lead lookup failures without failing the batch', async () => {
    db.getLeadById.mockImplementation(async (_l: string, id: string) => {
      if (id === 'b') throw new Error('throttled');
      return leadA;
    });
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: ['a', 'b'] });
    expect(r.success).toBe(true);
    expect(r.leads.find((x: any) => x.leadId === 'b')).toEqual({ leadId: 'b', status: 'error', error: 'throttled' });
    expect(r.errors).toBe(1);
  });

  it('denies access to a list the caller cannot read, before loading any lead', async () => {
    db.canOrgMemberAccessList.mockResolvedValue(false);
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: ['a'] });
    expect(r).toMatchObject({ success: false, message: 'Access denied' });
    expect(db.getLeadById).not.toHaveBeenCalled();
    expect(db.getLeadsByListId).not.toHaveBeenCalled();
  });

  it('pages a whole list with an opaque cursor', async () => {
    db.getLeadsByListId
      .mockResolvedValueOnce({ items: [leadA], lastEvaluatedKey: { leadId: 'a' } })
      .mockResolvedValueOnce({ items: [leadB], lastEvaluatedKey: undefined });
    const p1 = await getLeadConversationStatuses(listId, userId, { limit: 1 });
    expect(p1).toMatchObject({ success: true, count: 1, hasMore: true });
    const p2 = await getLeadConversationStatuses(listId, userId, { limit: 1, cursor: p1.nextCursor });
    expect(db.getLeadsByListId).toHaveBeenLastCalledWith(listId, 1, { leadId: 'a' });
    expect(p2).toMatchObject({ count: 1, hasMore: false, nextCursor: null });
  });

  it('rejects more than 200 lead_ids', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `l${i}`);
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: ids });
    expect(r.success).toBe(false);
    expect(db.getLeadById).not.toHaveBeenCalled();
  });

  it('reports failed signal reads as unknown, never as confirmed negatives', async () => {
    (conns.getAllConnectionsByAccount as jest.Mock).mockRejectedValue(new Error('unipile down'));
    (emailEventsDb.getEventsByEmailDomain as jest.Mock).mockRejectedValue(new Error('ddb throttled'));
    db.getLeadById.mockResolvedValue(leadB);
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: ['b'] });
    expect(r.success).toBe(true);
    expect(r.unavailableSignals).toEqual(expect.arrayContaining(['linkedin_connections', 'linkedin_messages', 'email_messages']));
    expect(r.leads[0]).toMatchObject({ connectionState: 'unknown', replyState: 'unknown' });
  });

  it('treats an explicit empty lead_ids as an empty selection, not whole-list mode', async () => {
    const r = await getLeadConversationStatuses(listId, userId, { leadIds: [] });
    expect(r.success).toBe(true);
    expect(r.count).toBe(0);
    expect(db.getLeadsByListId).not.toHaveBeenCalled();
  });
});
