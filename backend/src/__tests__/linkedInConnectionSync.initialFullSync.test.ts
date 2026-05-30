/**
 * Tests for syncConnectionsForAccount pagination behavior.
 *
 *  - Empty cache (getLatestConnectedAt === null) → treat as a FULL sync and
 *    paginate past the 3-page incremental cap, so accounts that already had
 *    >150 connections get fully backfilled (otherwise old connections never
 *    land in the cache and genuinely-connected leads look "not connected").
 *  - Non-empty cache → incremental: cap at 3 pages per poll.
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
jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: (...a: any[]) => mockUpsertConnections(...a),
  getLatestConnectedAt: (...a: any[]) => mockGetLatestConnectedAt(...a),
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

describe('syncConnectionsForAccount pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('full-syncs (paginates past 3 pages) when the cache is empty', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(null); // empty cache
    mockListConnections.mockImplementation(pagedListConnections(6, 1_700_000_000));

    const result = await syncConnectionsForAccount('acct-empty');

    // Must keep paginating past the 3-page incremental cap (6 pages here).
    expect(mockListConnections).toHaveBeenCalledTimes(6);
    expect(result.length).toBe(12);
  });

  it('caps at 3 pages for an incremental poll when the cache is populated', async () => {
    mockGetLatestConnectedAt.mockResolvedValue(1_000); // existing cache
    // All connections are newer than lastKnownAt, so no early-stop; the 3-page
    // cap is what bounds the poll.
    mockListConnections.mockImplementation(pagedListConnections(10, 2_000_000_000));

    await syncConnectionsForAccount('acct-existing');

    expect(mockListConnections).toHaveBeenCalledTimes(3);
  });
});
