/**
 * Tests for the 2026-06-03 outage fix: a flood of "X accepted your LinkedIn invitation"
 * emails caused by the connection-sync cron treating an account's FULL backfill of
 * historical connections as freshly-accepted invitations.
 *
 * Two independent guards are covered here:
 *  1. notifyNewConnections is MUTED unless LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED='true'.
 *  2. runLinkedInConnectionSync only feeds connections into notify/enroll when the account
 *     was ALREADY backfilled before the run (a cheap incremental poll) — never on the
 *     one-time full backfill that returns every historical connection.
 */

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { readBrandGuidelines: jest.fn(), readMarketStrategy: jest.fn() },
}));

const mockListConnections = jest.fn();
const mockListSentInvitations = jest.fn().mockResolvedValue({ items: [] });
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listConnections: (...a: any[]) => mockListConnections(...a),
    listSentInvitations: (...a: any[]) => mockListSentInvitations(...a),
  },
}));

const mockGetLatestConnectedAt = jest.fn();
const mockGetFullSyncCompletedAt = jest.fn();
jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: jest.fn().mockResolvedValue(undefined),
  getLatestConnectedAt: (...a: any[]) => mockGetLatestConnectedAt(...a),
  getFullSyncCompletedAt: (...a: any[]) => mockGetFullSyncCompletedAt(...a),
  markFullSyncCompleted: jest.fn().mockResolvedValue(undefined),
  normalizeLinkedInUrl: (url: string) => url.replace(/\/$/, '').toLowerCase(),
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitations: jest.fn().mockResolvedValue(undefined),
  pruneStaleSentInvitations: jest.fn().mockResolvedValue(0),
  profileUrlFromPublicId: (id: string) => `https://www.linkedin.com/in/${id}/`,
}));

const mockFindLeadsByLinkedin = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    findLeadsByLinkedin: (...a: any[]) => mockFindLeadsByLinkedin(...a),
    getLeadListById: jest.fn(),
    getLeadListsByUserId: jest.fn().mockResolvedValue([]),
    getLeadsByListId: jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: null }),
    updateLead: jest.fn().mockResolvedValue(undefined),
    getLeadEngagements: jest.fn().mockResolvedValue({ engagements: [] }),
  },
  userDb: { getAllUsers: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue({
      settingValue: JSON.stringify([{ account_id: 'acct-1', enabled: true }]),
    }),
  },
}));

const mockNotify = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLinkedInConnectionAccepted: (...a: any[]) => mockNotify(...a) },
}));

import {
  notifyNewConnections,
  linkedInConnectionNotificationsEnabled,
  runLinkedInConnectionSync,
} from '../cron/linkedInConnectionSyncCron';

const NEW_CONNECTION = {
  accountId: 'acct-1',
  memberId: 'member-abc',
  publicProfileUrl: 'https://www.linkedin.com/in/john-prospect',
  memberUrn: '',
  connectionUrn: '',
  firstName: 'John',
  lastName: 'Prospect',
  headline: 'CTO',
  connectedAt: 1_700_000_000,
  syncedAt: '2026-06-03T00:00:00.000Z',
};

const ORIGINAL_ENV = process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED;
  else process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = ORIGINAL_ENV;
});

describe('linkedInConnectionNotificationsEnabled — default-muted kill switch', () => {
  it('is muted (false) when the env var is unset', () => {
    delete process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED;
    expect(linkedInConnectionNotificationsEnabled()).toBe(false);
  });

  it('is muted (false) for any value other than the literal "true"', () => {
    process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = 'TRUE';
    expect(linkedInConnectionNotificationsEnabled()).toBe(false);
    process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = '1';
    expect(linkedInConnectionNotificationsEnabled()).toBe(false);
    process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = 'false';
    expect(linkedInConnectionNotificationsEnabled()).toBe(false);
  });

  it('is enabled (true) only for the literal "true"', () => {
    process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = 'true';
    expect(linkedInConnectionNotificationsEnabled()).toBe(true);
  });
});

describe('notifyNewConnections — respects the mute switch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends NO notifications when muted, even with matching leads', async () => {
    delete process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED;
    mockFindLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead-1', listId: 'list-1', email: 'john@example.com', linkedin: NEW_CONNECTION.publicProfileUrl },
    ]);

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockNotify).not.toHaveBeenCalled();
    // Muted path must short-circuit before any lead lookup.
    expect(mockFindLeadsByLinkedin).not.toHaveBeenCalled();
  });

  it('sends notifications when explicitly enabled', async () => {
    process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = 'true';
    mockFindLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead-1', listId: 'list-1', email: 'john@example.com', linkedin: NEW_CONNECTION.publicProfileUrl },
    ]);
    const { crmDb } = require('../services/db');
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', name: 'L', userId: 'u1' });

    await notifyNewConnections([NEW_CONNECTION]);

    expect(mockFindLeadsByLinkedin).toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});

describe('runLinkedInConnectionSync — suppresses notify/enroll on initial backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Allow notifications so we isolate the backfill guard, not the mute switch.
    process.env.LINKEDIN_CONNECTION_NOTIFICATIONS_ENABLED = 'true';
    mockListConnections.mockResolvedValue({
      items: [{ member_id: 'm1', public_identifier: 'john-prospect', created_at: 1_700_000_000 }],
      cursor: undefined,
    });
  });

  it('does NOT notify when the account has not yet been backfilled (marker absent)', async () => {
    // Marker absent → this run performs the full backfill → its connections are historical.
    mockGetFullSyncCompletedAt.mockResolvedValue(null);
    mockGetLatestConnectedAt.mockResolvedValue(null);
    mockFindLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead-1', listId: 'list-1', email: 'john@example.com', linkedin: NEW_CONNECTION.publicProfileUrl },
    ]);

    await runLinkedInConnectionSync();

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('DOES notify when the account was already backfilled before this run (incremental poll)', async () => {
    mockGetFullSyncCompletedAt.mockResolvedValue(1_780_000_000_000); // marker present
    mockGetLatestConnectedAt.mockResolvedValue(1_699_999_999); // older than the incoming connection
    mockFindLeadsByLinkedin.mockResolvedValue([
      { leadId: 'lead-1', listId: 'list-1', email: 'john@example.com', linkedin: NEW_CONNECTION.publicProfileUrl },
    ]);
    const { crmDb } = require('../services/db');
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', name: 'L', userId: 'u1' });

    await runLinkedInConnectionSync();

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});
