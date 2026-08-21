/**
 * ENG-926 §C — the reconciliation sweep must actually be REACHED by the cron.
 *
 * The sweep itself is covered in metaConversionReconcile.test.ts. This pins the wiring,
 * which is a separate failure mode: a sweep that is never called is indistinguishable from a
 * correct one at the unit level, and the whole point of it is to be the consumer that runs
 * without anyone touching the lead.
 */

const reconcilePendingConversionsForUser = jest
  .fn()
  .mockResolvedValue({ scannedLists: 0, pendingFound: 0, dispatched: 0, failed: 0, cappedOut: false });
jest.mock('../../services/metaConversionReconcile', () => ({
  reconcilePendingConversionsForUser: (...a: any[]) => reconcilePendingConversionsForUser(...a),
}));

const getAllUsers = jest.fn();
jest.mock('../../services/db', () => ({
  userDb: { getAllUsers: (...a: any[]) => getAllUsers(...a) },
}));

jest.mock('../../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ refreshed: false, attempted: false }),
  needsMetaRefresh: jest.fn().mockReturnValue(false),
  isMetaAdAccount: (acc: any) => acc?.config?.account_type === 'ad_account',
}));

jest.mock('../../services/metaAdsCapabilitySync', () => ({
  syncMetaAdsCapability: jest.fn().mockResolvedValue({ outcome: 'unchanged' }),
}));

import { runMetaTokenRefresh } from '../metaTokenRefreshCron';

const user = (userId: string) => ({
  userId,
  connected_accounts: [
    { platform: 'meta', account_id: 'a1', config: { account_type: 'ad_account', access_token: 't' } },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();
  reconcilePendingConversionsForUser.mockResolvedValue({
    scannedLists: 0,
    pendingFound: 0,
    dispatched: 0,
    failed: 0,
    cappedOut: false,
  });
});

describe('metaTokenRefreshCron → owed-conversion reconciliation', () => {
  it('runs the sweep once per user', async () => {
    getAllUsers.mockResolvedValue([user('u1'), user('u2')]);

    await runMetaTokenRefresh();

    expect(reconcilePendingConversionsForUser).toHaveBeenCalledTimes(2);
  });

  it('runs it even for a user with NO Meta account — the gate lives in the sweep', async () => {
    // The sweep decides for itself whether there is work; the cron must not second-guess it,
    // or a user whose connection shape changed would stop being reconciled.
    getAllUsers.mockResolvedValue([{ userId: 'u3', connected_accounts: [] }]);

    await runMetaTokenRefresh();

    expect(reconcilePendingConversionsForUser).toHaveBeenCalledTimes(1);
  });

  it('rolls the sweep results into the cron summary', async () => {
    getAllUsers.mockResolvedValue([user('u1'), user('u2')]);
    reconcilePendingConversionsForUser
      .mockResolvedValueOnce({ scannedLists: 1, pendingFound: 2, dispatched: 2, failed: 0, cappedOut: false })
      .mockResolvedValueOnce({ scannedLists: 1, pendingFound: 1, dispatched: 0, failed: 1, cappedOut: false });

    const summary: any = await runMetaTokenRefresh();

    expect(summary.pendingConversionsFound).toBe(3);
    expect(summary.pendingConversionsDispatched).toBe(2);
  });

  it('a sweep failure never aborts the rest of the cron', async () => {
    getAllUsers.mockResolvedValue([user('u1'), user('u2')]);
    reconcilePendingConversionsForUser.mockRejectedValueOnce(new Error('boom'));

    await expect(runMetaTokenRefresh()).resolves.toBeDefined();
    expect(reconcilePendingConversionsForUser).toHaveBeenCalledTimes(2);
  });
});
