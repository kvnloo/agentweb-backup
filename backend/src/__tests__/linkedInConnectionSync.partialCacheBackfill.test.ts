/**
 * Tests for syncConnectionsForAccount one-time full backfill of PARTIAL caches.
 *
 * Bug (2026-06-03): the empty-cache full-sync fix only triggered a backfill when the
 * cache was COMPLETELY empty (getLatestConnectedAt === null). Accounts whose cache was
 * partially populated by incremental polls before that fix (so a __latest__ watermark
 * already exists) stayed on 3-page incremental polls forever and never backfilled their
 * older connections — leaving genuinely-connected leads absent from the cache, so the
 * CRM kept offering "Send LinkedIn Invite" which then failed live as "already connected".
 *
 * Fix: a per-account __fullsync__ sentinel. If it's absent the account is full-synced
 * once (regardless of whether the cache is empty or partial), then the sentinel is set
 * so subsequent polls revert to incremental.
 */

jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: jest.fn() } },
})));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { readBrandGuidelines: jest.fn(), readMarketStrategy: jest.fn() },
}));

const mockListConnections = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { listConnections: (...a: any[]) => mockListConnections(...a) },
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
  normalizeLinkedInUrl: (url: string) => url.replace(/\/$/, '').toLowerCase(),
}));

jest.mock('../services/dripSequenceDb', () => ({
  dripSequenceDb: { getAllSequencesByTriggerType: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/db', () => ({ crmDb: {}, userDb: { getAllUsers: jest.fn() } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));

import { syncConnectionsForAccount } from '../cron/linkedInConnectionSyncCron';

// Each page returns 2 connections + a cursor, until `lastPage` where cursor is null.
const pagedListConnections = (lastPage: number, createdAt: number) => {
  let call = 0;
  return jest.fn().mockImplementation(() => {
    call++;
    return Promise.resolve({
      items: [
        { member_id: `m-${call}-a`, public_identifier: `u${call}a`, created_at: createdAt },
        { member_id: `m-${call}-b`, public_identifier: `u${call}b`, created_at: createdAt },
      ],
      cursor: call < lastPage ? `cursor-${call}` : undefined,
    });
  });
};

describe('syncConnectionsForAccount partial-cache backfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('full-syncs a PARTIAL cache (watermark present) when no __fullsync__ marker exists', async () => {
    // Cache already partially populated (watermark set) but never fully backfilled.
    mockGetLatestConnectedAt.mockResolvedValue(1_700_000_000);
    mockGetFullSyncCompletedAt.mockResolvedValue(null); // never full-synced
    mockListConnections.mockImplementation(pagedListConnections(6, 1_700_000_000));

    const result = await syncConnectionsForAccount('acct-partial');

    // Must paginate past the 3-page incremental cap (6 pages here).
    expect(mockListConnections).toHaveBeenCalledTimes(6);
    expect(result.length).toBe(12);
  });

  it('marks the account __fullsync__ complete after a successful backfill', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(1_700_000_000);
    mockGetFullSyncCompletedAt.mockResolvedValue(null);
    mockListConnections.mockImplementation(pagedListConnections(4, 1_700_000_000));

    await syncConnectionsForAccount('acct-partial');

    expect(mockMarkFullSyncCompleted).toHaveBeenCalledWith('acct-partial');
  });

  it('reverts to a 3-page incremental poll once __fullsync__ is marked complete', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(1_000);
    mockGetFullSyncCompletedAt.mockResolvedValue(1_780_000_000_000); // already backfilled
    // All connections newer than lastKnownAt → no early-stop; the 3-page cap bounds the poll.
    mockListConnections.mockImplementation(pagedListConnections(10, 2_000_000_000));

    await syncConnectionsForAccount('acct-done');

    expect(mockListConnections).toHaveBeenCalledTimes(3);
    expect(mockMarkFullSyncCompleted).not.toHaveBeenCalled();
  });

  it('still full-syncs an EMPTY cache (no watermark, no marker) and marks it complete', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(null);
    mockGetFullSyncCompletedAt.mockResolvedValue(null);
    mockListConnections.mockImplementation(pagedListConnections(6, 1_700_000_000));

    const result = await syncConnectionsForAccount('acct-empty');

    expect(mockListConnections).toHaveBeenCalledTimes(6);
    expect(result.length).toBe(12);
    expect(mockMarkFullSyncCompleted).toHaveBeenCalledWith('acct-empty');
  });

  it('honours an explicit opts.fullSync even when already marked complete', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(1_000);
    mockGetFullSyncCompletedAt.mockResolvedValue(1_780_000_000_000);
    mockListConnections.mockImplementation(pagedListConnections(6, 2_000_000_000));

    await syncConnectionsForAccount('acct-manual', { fullSync: true });

    expect(mockListConnections).toHaveBeenCalledTimes(6);
  });
});
