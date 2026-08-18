/**
 * Tests for runLinkedInConnectionSync's initial-backfill suppression.
 *
 * The first-ever sync for an account pulls ALL historical connections into the
 * cache. Those are old accepted invitations, NOT freshly accepted ones — so the
 * cron must NOT email the list owner or auto-enroll for them. On later runs
 * (cache already populated), genuinely-new connections are processed normally.
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

const mockUpsertConnections = jest.fn().mockResolvedValue(undefined);
const mockGetLatestConnectedAt = jest.fn();
const mockGetFullSyncCompletedAt = jest.fn();
const mockMarkFullSyncCompleted = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: (...a: any[]) => mockUpsertConnections(...a),
  getLatestConnectedAt: (...a: any[]) => mockGetLatestConnectedAt(...a),
  getFullSyncCompletedAt: (...a: any[]) => mockGetFullSyncCompletedAt(...a),
  markFullSyncCompleted: (...a: any[]) => mockMarkFullSyncCompleted(...a),
  normalizeLinkedInUrl: (url: string) => {
    let u = url.trim().toLowerCase();
    if (!u.endsWith('/')) u += '/';
    return u;
  },
}));

const mockUpsertSentInvitations = jest.fn().mockResolvedValue(undefined);
const mockPruneStaleSentInvitations = jest.fn().mockResolvedValue(0);
jest.mock('../services/unipileSentInvitationsDb', () => ({
  upsertSentInvitations: (...a: any[]) => mockUpsertSentInvitations(...a),
  pruneStaleSentInvitations: (...a: any[]) => mockPruneStaleSentInvitations(...a),
  profileUrlFromPublicId: (id: string) => `https://www.linkedin.com/in/${id}/`,
}));

const mockGetAllSequencesByTriggerType = jest.fn().mockResolvedValue([]);
jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: (...a: any[]) => mockGetAllSequencesByTriggerType(...a) },
}));

const mockFindLeadsByLinkedin = jest.fn().mockResolvedValue([]);
const mockGetAllUsers = jest.fn().mockResolvedValue([]);
jest.mock('../services/db', () => ({
  crmDb: { findLeadsByLinkedin: (...a: any[]) => mockFindLeadsByLinkedin(...a) },
  userDb: { getAllUsers: (...a: any[]) => mockGetAllUsers(...a) },
}));

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: any[]) => mockGetSetting(...a) },
}));

const mockNotifyLinkedInConnectionAccepted = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/leadListAlertService', () => ({
  leadListAlertService: { notifyLinkedInConnectionAccepted: (...a: any[]) => mockNotifyLinkedInConnectionAccepted(...a) },
}));

import { runLinkedInConnectionSync, __resetWalkPacingForTests } from '../cron/linkedInConnectionSyncCron';

const onePageOfConnections = () =>
  jest.fn().mockResolvedValueOnce({
    items: [
      { member_id: 'm-1', public_identifier: 'alice', public_profile_url: 'https://www.linkedin.com/in/alice/', created_at: 1_700_000_000 },
      { member_id: 'm-2', public_identifier: 'bob', public_profile_url: 'https://www.linkedin.com/in/bob/', created_at: 1_700_000_001 },
    ],
    cursor: undefined,
  });

beforeEach(() => {
  // ENG-1197: the cron paces its full walk per account in module state.
  __resetWalkPacingForTests();
  jest.clearAllMocks();
  // Single site-wide account to sync.
  mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify([{ account_id: 'acct-1', enabled: true }]) });
  mockGetAllUsers.mockResolvedValue([]);
  // Enable the notify/enroll kill-switches so the "processes normally" assertions
  // reflect the backfill gate, not the global mute (which is covered elsewhere).
  process.env.LINKEDIN_CONNECTION_NOTIFY = 'true';
  process.env.LINKEDIN_CONNECTION_ENROLL = 'true';
});

afterAll(() => {
  delete process.env.LINKEDIN_CONNECTION_NOTIFY;
  delete process.env.LINKEDIN_CONNECTION_ENROLL;
});

describe('runLinkedInConnectionSync — one-time backfill suppression', () => {
  it('does NOT notify or enroll on a backfill run (empty cache, no fullsync marker)', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(null);     // empty cache
    mockGetFullSyncCompletedAt.mockResolvedValue(null);   // marker absent → backfill
    mockListConnections.mockImplementation(onePageOfConnections());

    await runLinkedInConnectionSync();

    // Connections were still cached…
    expect(mockUpsertConnections).toHaveBeenCalled();
    // …but no acceptance notifications and no sequence enrollment fired.
    expect(mockFindLeadsByLinkedin).not.toHaveBeenCalled();
    expect(mockNotifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
    expect(mockGetAllSequencesByTriggerType).not.toHaveBeenCalled();
  });

  it('does NOT notify or enroll on a backfill run for a PARTIAL cache (watermark set, marker absent)', async () => {
    // The production flood case: the cache already had some connections (watermark
    // non-null) but the one-time full backfill had never run (marker absent), so
    // syncConnectionsForAccount full-syncs and would otherwise notify for every
    // historical connection. Suppression must key off the fullsync marker, not the
    // watermark.
    mockGetLatestConnectedAt.mockResolvedValue(1_700_000_000); // partial cache
    mockGetFullSyncCompletedAt.mockResolvedValue(null);        // marker absent → backfill
    mockListConnections.mockImplementation(onePageOfConnections());

    await runLinkedInConnectionSync();

    expect(mockUpsertConnections).toHaveBeenCalled();
    expect(mockFindLeadsByLinkedin).not.toHaveBeenCalled();
    expect(mockNotifyLinkedInConnectionAccepted).not.toHaveBeenCalled();
    expect(mockGetAllSequencesByTriggerType).not.toHaveBeenCalled();
  });

  it('processes new connections normally once the one-time backfill has completed', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(1);             // populated cache
    mockGetFullSyncCompletedAt.mockResolvedValue(1_700_000_000); // marker set → incremental
    mockListConnections.mockImplementation(onePageOfConnections());

    await runLinkedInConnectionSync();

    expect(mockUpsertConnections).toHaveBeenCalled();
    // Notification lookup runs for the genuinely-new connections.
    expect(mockFindLeadsByLinkedin).toHaveBeenCalled();
    expect(mockGetAllSequencesByTriggerType).toHaveBeenCalled();
  });
});
