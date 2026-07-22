/**
 * Tests for AgentModeService.getLeadsNeedingFollowup().
 *
 * This list-level tool answers "which leads accepted my LinkedIn invite but
 * haven't been followed up?" in a constant number of queries (NOT N+1):
 *   - one getAllConnectionsByAccount(accountId) call  -> connection status + connectedAt
 *   - one getEventsByEmailDomain(`linkedin-{listId}`)  -> LinkedIn message direction/timestamps
 *   - one getEventsByEmailDomain(userEmailDomain)      -> email message direction/timestamps
 *   - one page (or a few) of getLeadsByListId          -> the leads themselves
 *
 * It then segments leads by follow-up state in memory and returns the
 * "accepted-but-not-followed-up" cohort with the signal fields the bug report
 * asked for: linkedInConnectionStatus, lastEngagement{Type,Direction,At},
 * awaitingReply.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn(),
  },
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  getAllConnectionsByAccount: jest.fn(),
  // Mirror the real normalizer so URL keys line up in tests.
  normalizeLinkedInUrl: (url: string) => {
    let u = url.trim().toLowerCase();
    if (!u.endsWith('/')) u += '/';
    return u;
  },
}));

// Minimal stubs for transitive dependencies pulled in by agentModeService
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService',  () => ({ gmailService:  { sendEmail: jest.fn() } }));

import { AgentModeService } from '../services/agentModeService';
import { crmDb, userDb } from '../services/db';
import { emailEventsDb } from '../services/emailEventsDb';
import * as unipileConnectionsDb from '../services/unipileConnectionsDb';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockGetEventsByDomain = emailEventsDb.getEventsByEmailDomain as jest.Mock;
const mockGetAllConnections = unipileConnectionsDb.getAllConnectionsByAccount as jest.Mock;

describe('AgentModeService.getLeadsNeedingFollowup', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const listId = 'list-1';
  const linkedInAccountId = 'acc-1';
  const emailDomain = 'mycompany.com';

  const list = { listId, userId, name: 'Outreach', linkedInAccountId };

  // connectedAt epoch MILLISECONDS: 2026-05-01 (matches AW-UnipileConnections storage).
  // Must be ms — with the old seconds assumption the `* 1000` scaling pushed the
  // "already followed up" comparison ~56,000 years out and it never fired (ENG-379).
  const CONNECTED_TS = new Date('2026-05-01T00:00:00.000Z').getTime();

  const accepted = {
    leadId: 'lead-accepted',
    listId,
    firstName: 'Anna',
    lastName: 'Accepted',
    email: 'anna@acme.com',
    company: 'Acme',
    title: 'CEO',
    linkedin: 'https://www.linkedin.com/in/anna/',
  };
  const notConnected = {
    leadId: 'lead-notconnected',
    listId,
    firstName: 'Ned',
    lastName: 'NotConnected',
    email: 'ned@beta.com',
    linkedin: 'https://www.linkedin.com/in/ned/',
  };
  const repliedAwaiting = {
    leadId: 'lead-replied',
    listId,
    firstName: 'Rita',
    lastName: 'Replied',
    email: 'rita@gamma.com',
    linkedin: 'https://www.linkedin.com/in/rita/',
  };
  const alreadyFollowedUp = {
    leadId: 'lead-followed',
    listId,
    firstName: 'Frank',
    lastName: 'Followed',
    email: 'frank@delta.com',
    linkedin: 'https://www.linkedin.com/in/frank/',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    mockCrmDb.getLeadListById.mockResolvedValue(list as any);
    mockUserDb.getUserById.mockResolvedValue({ userId, emailDomain } as any);
    mockGetAllConnections.mockResolvedValue([]);
    mockGetEventsByDomain.mockResolvedValue([]);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
  });

  it('returns "Lead list not found" when list does not exist', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(null as any);
    const result = await service.getLeadsNeedingFollowup(listId, userId, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it('returns "Access denied" when the user cannot access the list', async () => {
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(false);
    const result = await service.getLeadsNeedingFollowup(listId, userId, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/access denied/i);
  });

  it('errors clearly when the list has no LinkedIn account assigned', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({ ...list, linkedInAccountId: null } as any);
    const result = await service.getLeadsNeedingFollowup(listId, userId, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/linkedin account/i);
  });

  it('does NOT call get_lead_details per lead (constant query count, no N+1)', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [accepted, notConnected],
      lastEvaluatedKey: undefined,
    } as any);
    mockGetAllConnections.mockResolvedValue([
      { publicProfileUrl: 'https://www.linkedin.com/in/anna/', connectedAt: CONNECTED_TS },
    ]);

    await service.getLeadsNeedingFollowup(listId, userId, {});

    // Exactly one connections query + exactly one query per event domain (linkedin + email)
    expect(mockGetAllConnections).toHaveBeenCalledTimes(1);
    expect(mockGetEventsByDomain).toHaveBeenCalledWith(`linkedin-${listId}`);
    expect(mockGetEventsByDomain).toHaveBeenCalledWith(emailDomain);
  });

  it('surfaces an accepted-but-not-contacted lead (connected, no outbound after connect)', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [accepted],
      lastEvaluatedKey: undefined,
    } as any);
    mockGetAllConnections.mockResolvedValue([
      { publicProfileUrl: 'https://www.linkedin.com/in/anna/', connectedAt: CONNECTED_TS },
    ]);
    // Only an outbound invite BEFORE the connection — nothing after acceptance.
    mockGetEventsByDomain.mockImplementation(async (domain: string) => {
      if (domain === `linkedin-${listId}`) {
        return [
          {
            eventId: 'e1',
            eventType: 'linkedin.message.sent',
            leadEmail: 'https://www.linkedin.com/in/anna/',
            createdAt: '2026-04-01T00:00:00.000Z', // before CONNECTED_TS
            data: { text: 'hi' },
          },
        ];
      }
      return [];
    });

    const result = await service.getLeadsNeedingFollowup(listId, userId, {});

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(1);
    const lead = result.leads[0];
    expect(lead.leadId).toBe('lead-accepted');
    expect(lead.linkedInConnectionStatus.isConnected).toBe(true);
    expect(lead.linkedInConnectionStatus.connectedAt).toBe(new Date(CONNECTED_TS).toISOString());
    // Regression guard for ENG-379: the connect year must be sane, not ~58000.
    expect(new Date(lead.linkedInConnectionStatus.connectedAt).getUTCFullYear()).toBe(2026);
    expect(lead.awaitingReply).toBe(false); // we owe them the next touch
    expect(result.matchCount).toBe(1);
  });

  it('excludes leads that are not connected (invite still pending)', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [notConnected],
      lastEvaluatedKey: undefined,
    } as any);
    mockGetAllConnections.mockResolvedValue([]); // nobody connected

    const result = await service.getLeadsNeedingFollowup(listId, userId, {});

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(0);
  });

  it('excludes leads already followed up after connecting (outbound after connectedAt)', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [alreadyFollowedUp],
      lastEvaluatedKey: undefined,
    } as any);
    mockGetAllConnections.mockResolvedValue([
      { publicProfileUrl: 'https://www.linkedin.com/in/frank/', connectedAt: CONNECTED_TS },
    ]);
    mockGetEventsByDomain.mockImplementation(async (domain: string) => {
      if (domain === `linkedin-${listId}`) {
        return [
          {
            eventId: 'e2',
            eventType: 'linkedin.message.sent',
            leadEmail: 'https://www.linkedin.com/in/frank/',
            createdAt: '2026-05-10T00:00:00.000Z', // AFTER CONNECTED_TS
            data: { text: 'following up!' },
          },
        ];
      }
      return [];
    });

    const result = await service.getLeadsNeedingFollowup(listId, userId, {});

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(0);
  });

  it('marks awaitingReply=true when the last engagement is inbound (they replied)', async () => {
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [repliedAwaiting],
      lastEvaluatedKey: undefined,
    } as any);
    mockGetAllConnections.mockResolvedValue([
      { publicProfileUrl: 'https://www.linkedin.com/in/rita/', connectedAt: CONNECTED_TS },
    ]);
    mockGetEventsByDomain.mockImplementation(async (domain: string) => {
      if (domain === `linkedin-${listId}`) {
        return [
          {
            eventId: 'e3',
            eventType: 'linkedin.message.sent',
            leadEmail: 'https://www.linkedin.com/in/rita/',
            createdAt: '2026-05-02T00:00:00.000Z',
            data: { text: 'thanks for connecting' },
          },
          {
            eventId: 'e4',
            eventType: 'linkedin.message.received',
            leadEmail: 'https://www.linkedin.com/in/rita/',
            createdAt: '2026-05-03T00:00:00.000Z', // inbound is the most recent
            data: { text: 'sure, tell me more' },
          },
        ];
      }
      return [];
    });

    const result = await service.getLeadsNeedingFollowup(listId, userId, {});

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(1);
    const lead = result.leads[0];
    expect(lead.awaitingReply).toBe(true);
    expect(lead.lastEngagementDirection).toBe('inbound');
    expect(lead.lastEngagementType).toBe('linkedin.message.received');
    expect(lead.lastEngagementAt).toBe('2026-05-03T00:00:00.000Z');
  });

  it('respects the limit option', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      leadId: `lead-${i}`,
      listId,
      firstName: `L${i}`,
      linkedin: `https://www.linkedin.com/in/lead${i}/`,
    }));
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: many, lastEvaluatedKey: undefined } as any);
    mockGetAllConnections.mockResolvedValue(
      many.map((l) => ({ publicProfileUrl: l.linkedin, connectedAt: CONNECTED_TS })),
    );
    // No engagement at all after connect -> all need follow-up.

    const result = await service.getLeadsNeedingFollowup(listId, userId, { limit: 2 });

    expect(result.success).toBe(true);
    expect(result.leads.length).toBeLessThanOrEqual(2);
  });

  it('returns a graceful error object on unexpected failure', async () => {
    mockCrmDb.getLeadListById.mockRejectedValue(new Error('boom'));
    const result = await service.getLeadsNeedingFollowup(listId, userId, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/failed/i);
  });
});
