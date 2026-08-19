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

const checkConversionDivergenceForUser = jest.fn();
jest.mock('../../services/metaConversionDivergence', () => ({
  checkConversionDivergenceForUser: (...a: any[]) => checkConversionDivergenceForUser(...a),
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
  checkConversionDivergenceForUser.mockResolvedValue({ status: 'skipped' });
});

describe('metaTrackingMonitorCron — duplicate ad accounts (ENG-1326)', () => {
  it('passes ONE shared set to every user, so an account is swept once per run', async () => {
    // 21 production connection rows resolve to 15 distinct ad accounts. Without a set shared
    // across users, each duplicate is a full second sweep and every counter double-counts.
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);

    await runMetaTrackingMonitor();

    const sets = monitorUserTracking.mock.calls.map((c: any[]) => c[1]?.sweptAccountIds);
    expect(sets).toHaveLength(3);
    expect(sets[0]).toBeInstanceOf(Set);
    // The SAME object, not three fresh ones — a per-user set would dedupe nothing.
    expect(sets[1]).toBe(sets[0]);
    expect(sets[2]).toBe(sets[0]);
  });

  it('aggregates the skipped-duplicate counter', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    monitorUserTracking
      .mockResolvedValueOnce(summary({ duplicateAccountsSkipped: 0 }))
      .mockResolvedValueOnce(summary({ duplicateAccountsSkipped: 2 }));

    const result = await runMetaTrackingMonitor();

    expect(result.duplicateAccountsSkipped).toBe(2);
  });

  it('treats a summary without the field as 0, not NaN', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }]);
    monitorUserTracking.mockResolvedValue(summary());
    const result = await runMetaTrackingMonitor();
    expect(result.duplicateAccountsSkipped).toBe(0);
    expect(Number.isNaN(result.duplicateAccountsSkipped)).toBe(false);
  });
});

describe('metaTrackingMonitorCron — §G destination counters', () => {
  it('aggregates destination counters across users', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    monitorUserTracking
      .mockResolvedValueOnce(summary({ destinationAlerts: 2, destinationUnverifiable: 1, destinationOk: 5, destinationUnconfirmed: 1 }))
      .mockResolvedValueOnce(summary({ destinationAlerts: 1, destinationUnverifiable: 0, destinationOk: 7, destinationUnconfirmed: 2 }));

    const result = await runMetaTrackingMonitor();

    expect(result.destinationAlerts).toBe(3);
    expect(result.destinationUnverifiable).toBe(1);
    expect(result.destinationOk).toBe(12);
    expect(result.destinationUnconfirmed).toBe(3);
  });

  it('treats a monitor result missing the counters as zero, not NaN', async () => {
    // Every downstream guard is a `> 0` comparison, and NaN fails all of them silently — the
    // counter would read as "no findings" forever rather than as broken. A per-user summary
    // predating these fields (an older worker mid-deploy) must not poison the fleet total.
    getAllUsers.mockResolvedValue([{ userId: 'u1' }]);
    monitorUserTracking.mockResolvedValue(summary());

    const result = await runMetaTrackingMonitor();

    expect(result.destinationAlerts).toBe(0);
    expect(result.destinationOk).toBe(0);
    expect(Number.isNaN(result.destinationAlerts)).toBe(false);
  });

  it('always reports destinations verified, so a check that ran is distinguishable from one that did not', async () => {
    // Zero alerts is ambiguous alone: it reads identically whether every destination was
    // healthy or none was ever fetched. The verified count is the only thing separating them.
    getAllUsers.mockResolvedValue([{ userId: 'u1' }]);
    monitorUserTracking.mockResolvedValue(summary({ destinationOk: 4 }));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runMetaTrackingMonitor();

    const swept = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('swept'))!;
    expect(swept).toContain('4 destination(s) verified');
    log.mockRestore();
  });
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

describe('metaTrackingMonitorCron — the divergence half', () => {
  it('runs the divergence check for every user too', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

    await runMetaTrackingMonitor();

    expect(checkConversionDivergenceForUser).toHaveBeenCalledTimes(2);
  });

  it('counts only accounts whose relayed conversions are not arriving', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    checkConversionDivergenceForUser
      .mockResolvedValueOnce({ status: 'not-arriving', crmSent: 5, metaSeen: 0 })
      .mockResolvedValueOnce({ status: 'ok', crmSent: 5, metaSeen: 5 })
      .mockResolvedValueOnce({ status: 'skipped' });

    const result = await runMetaTrackingMonitor();

    expect(result.conversionDivergences).toBe(1);
  });

  it('keeps the two checks independent — one failing must not suppress the other', async () => {
    // They answer different questions. A divergence check that throws must not make an
    // account with real spend and zero conversions go unexamined.
    getAllUsers.mockResolvedValue([{ userId: 'u1' }]);
    checkConversionDivergenceForUser.mockRejectedValue(new Error('boom'));
    monitorUserTracking.mockResolvedValue(summary({ blackouts: 1 }));

    const result = await runMetaTrackingMonitor();

    expect(result.blackouts).toBe(1);
    expect(result.usersScanned).toBe(1);
  });

  it('still runs the divergence check when the spend sweep threw', async () => {
    getAllUsers.mockResolvedValue([{ userId: 'u1' }]);
    monitorUserTracking.mockRejectedValue(new Error('boom'));

    await runMetaTrackingMonitor();

    expect(checkConversionDivergenceForUser).toHaveBeenCalledTimes(1);
  });
});
