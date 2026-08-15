/**
 * ENG-926 §F — the sweep must actually be REACHED, for every user, every day.
 *
 * The monitor itself is covered in the metaTrackingMonitor suites. This pins the wiring,
 * which is a separate failure mode: a monitor that is never called is indistinguishable
 * from a healthy fleet, and "looks fine because nothing ran" is the exact failure this
 * card exists to end.
 */

const monitorUserTracking = jest.fn();
jest.mock('../../services/metaTrackingMonitor', () => ({
  monitorUserTracking: (...a: any[]) => monitorUserTracking(...a),
}));

const getAllUsers = jest.fn();
jest.mock('../../services/db', () => ({
  userDb: { getAllUsers: (...a: any[]) => getAllUsers(...a) },
}));

import { runMetaTrackingMonitor } from '../metaTrackingMonitorCron';

const summary = (over: any = {}) => ({
  accountsChecked: 1,
  blackouts: 0,
  tokenErrors: 0,
  fetchErrors: 0,
  unclassifiable: 0,
  idle: 0,
  healthy: 1,
  unrecognizedActionTypes: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  monitorUserTracking.mockResolvedValue(summary());
});

describe('metaTrackingMonitorCron', () => {
  it('sweeps every user', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);

    await runMetaTrackingMonitor();

    expect(monitorUserTracking).toHaveBeenCalledTimes(3);
  });

  it('rolls per-user results into one fleet summary', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    monitorUserTracking
      .mockResolvedValueOnce(summary({ accountsChecked: 2, blackouts: 1, healthy: 1 }))
      .mockResolvedValueOnce(summary({ accountsChecked: 1, tokenErrors: 1, healthy: 0 }));

    const result = await runMetaTrackingMonitor();

    expect(result.accountsChecked).toBe(3);
    expect(result.blackouts).toBe(1);
    expect(result.tokenErrors).toBe(1);
    expect(result.usersScanned).toBe(2);
  });

  it('collects unknown action types across the whole fleet, deduplicated', async () => {
    // One customer with an unusual objective teaches the classifier for everyone, so the
    // names are worth surfacing once per run rather than per account.
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    monitorUserTracking
      .mockResolvedValueOnce(summary({ unrecognizedActionTypes: ['type_a', 'type_b'] }))
      .mockResolvedValueOnce(summary({ unrecognizedActionTypes: ['type_b', 'type_c'] }));

    const result = await runMetaTrackingMonitor();

    expect(result.unrecognizedActionTypes.sort()).toEqual(['type_a', 'type_b', 'type_c']);
  });

  it('one user failing never abandons the rest of the fleet', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    monitorUserTracking.mockRejectedValueOnce(new Error('boom'));

    const result = await runMetaTrackingMonitor();

    expect(monitorUserTracking).toHaveBeenCalledTimes(3);
    expect(result.usersScanned).toBe(3);
  });

  it('survives the user listing itself failing', async () => {
    getAllUsers.mockRejectedValue(new Error('dynamo down'));
    await expect(runMetaTrackingMonitor()).resolves.toBeDefined();
  });

  it('handles an empty fleet without touching the monitor', async () => {
    getAllUsers.mockResolvedValue([]);
    const result = await runMetaTrackingMonitor();
    expect(result.usersScanned).toBe(0);
    expect(monitorUserTracking).not.toHaveBeenCalled();
  });
});
