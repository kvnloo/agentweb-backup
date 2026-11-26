/** ENG-2781 seat option (a): flagged open tester window, no billing in it, Databricks exemption flag. */
import { zomaOpenTesterWindowActive, DEFAULT_ZOMA_OPEN_TESTER_UNTIL } from '../services/zomaOpenWindow';
import {
  assertZomaPublishAllowed, getZomaPlanSummary, reportZomaBillableCall, resetZomaBillingCacheForTests,
} from '../mcp/zomaBilling';

const BEFORE = Date.parse('2026-12-02T12:00:00Z');
const AFTER = Date.parse('2026-12-03T09:00:00Z');
const on = { ZOMA_DATABRICKS_LAUNCH_ENABLED: 'true' } as NodeJS.ProcessEnv;
const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

describe('zomaOpenTesterWindowActive', () => {
  it('is off without the flag, even before the end date', () => {
    expect(zomaOpenTesterWindowActive(BEFORE, {} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('is on with the flag before the default end (Dec 3 00:00 PT) and off after', () => {
    expect(DEFAULT_ZOMA_OPEN_TESTER_UNTIL).toBe('2026-12-03T08:00:00Z');
    expect(zomaOpenTesterWindowActive(BEFORE, on)).toBe(true);
    expect(zomaOpenTesterWindowActive(AFTER, on)).toBe(false);
  });
  it('honours ZOMA_OPEN_TESTER_UNTIL with an explicit offset and fails closed otherwise', () => {
    expect(zomaOpenTesterWindowActive(AFTER, { ...on, ZOMA_OPEN_TESTER_UNTIL: '2026-12-10T00:00:00Z' })).toBe(true);
    expect(zomaOpenTesterWindowActive(AFTER, { ...on, ZOMA_OPEN_TESTER_UNTIL: '2026-12-10T00:00:00-08:00' })).toBe(true);
    expect(zomaOpenTesterWindowActive(BEFORE, { ...on, ZOMA_OPEN_TESTER_UNTIL: 'nope' })).toBe(false);
    expect(zomaOpenTesterWindowActive(BEFORE, { ...on, ZOMA_OPEN_TESTER_UNTIL: '2026-12-10' })).toBe(false);
    expect(zomaOpenTesterWindowActive(BEFORE, { ...on, ZOMA_OPEN_TESTER_UNTIL: '2026-12-10T00:00:00' })).toBe(false);
  });
});

describe('billing during the window', () => {
  beforeEach(() => resetZomaBillingCacheForTests());
  const depsAt = (now: number) => {
    const findCustomerId = jest.fn().mockRejectedValue(new Error('plan read'));
    const sendMeterEvent = jest.fn();
    const deps: any = {
      config: () => ({ enabled: true, meterEventName: 'zoma_call' }), now: () => now, findCustomerId,
      listSubscriptions: jest.fn(), sendMeterEvent, recordFunnel: jest.fn().mockResolvedValue(undefined),
    };
    return { deps, findCustomerId, sendMeterEvent };
  };

  it('flag on, before the end: no paywall, no trial link, no meter event, no Stripe read', async () => {
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    delete process.env.ZOMA_OPEN_TESTER_UNTIL;
    const { deps, findCustomerId, sendMeterEvent } = depsAt(BEFORE);
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, deps)).resolves.toBeUndefined();
    expect(await getZomaPlanSummary('u1', deps)).toEqual({ status: 'none', publish_enabled: true });
    expect(await reportZomaBillableCall('u1', 'id-1', deps)).toBe(false);
    expect(findCustomerId).not.toHaveBeenCalled();
    expect(sendMeterEvent).not.toHaveBeenCalled();
  });

  it('flag on, after the end: billing applies again', async () => {
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    delete process.env.ZOMA_OPEN_TESTER_UNTIL;
    const { deps, findCustomerId } = depsAt(AFTER);
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, deps)).rejects.toThrow(/Zoma plan/);
    expect(findCustomerId).toHaveBeenCalled();
  });

  it('production today (flag off), before Dec 3: the paywall, plan check and metering all still apply', async () => {
    delete process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED;
    delete process.env.ZOMA_OPEN_TESTER_UNTIL;
    const { deps, findCustomerId } = depsAt(BEFORE);
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, deps)).rejects.toThrow(/Zoma plan/);
    expect((await getZomaPlanSummary('u1', deps))?.publish_enabled).toBe(false);
    await expect(reportZomaBillableCall('u1', 'id-2', deps)).rejects.toThrow('plan read');
    expect(findCustomerId).toHaveBeenCalledTimes(3);
  });
});

/** In-memory AW-Waitlist that evaluates the condition expressions zomaAdmission uses. */
function fakeWaitlist(seed: Record<string, any> = {}) {
  const rows: Record<string, any> = { __zoma_free_capacity__: { approvedCount: 5 }, ...JSON.parse(JSON.stringify(seed)) };
  const failed = () => { const e: any = new Error('cond'); e.code = 'ConditionalCheckFailedException'; return e; };
  const holds = (cond: string | undefined, row: any, v: Record<string, any>) => {
    if (!cond) return true;
    if (cond === 'attribute_not_exists(zomaStatus)') return !row?.zomaStatus;
    if (cond === 'zomaStatus = :pending') return row?.zomaStatus === v[':pending'];
    throw new Error(`unhandled condition ${cond}`);
  };
  const apply = (p: any) => {
    const row = rows[p.Key.email];
    if (!holds(p.ConditionExpression, row, p.ExpressionAttributeValues)) throw failed();
    const next = { ...(row ?? {}) };
    for (const part of p.UpdateExpression.replace(/^SET /, '').split(/,(?![^(]*\))/)) {
      const [k, expr] = part.split('=').map((s: string) => s.trim());
      const m = /^if_not_exists\((\w+), (:\w+)\)$/.exec(expr);
      next[k] = m ? (next[m[1]] ?? p.ExpressionAttributeValues[m[2]]) : p.ExpressionAttributeValues[expr];
    }
    rows[p.Key.email] = next;
  };
  const update = jest.fn((p: any) => ({ promise: async () => apply(p) }));
  const get = jest.fn((p: any) => ({ promise: async () => ({ Item: rows[p.Key.email] }) }));
  const transactWrite = jest.fn(() => ({ promise: async () => { rows.__zoma_free_capacity__.approvedCount += 1; } }));
  return { rows, update, get, transactWrite };
}

async function loadAdmission(fake: ReturnType<typeof fakeWaitlist>) {
  jest.resetModules();
  jest.dontMock('../services/zomaAdmission');
  jest.doMock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => fake) } } }));
  return import('../services/zomaAdmission');
}
const noInvite = { hasPendingOrgInvite: async () => false };

describe('open-window admissions are durable and never override a Reject', () => {
  afterEach(() => { jest.resetModules(); jest.dontMock('aws-sdk'); });
  const openWindow = () => {
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    process.env.ZOMA_OPEN_TESTER_UNTIL = '2999-01-01T00:00:00Z';
  };
  const closeWindow = () => { process.env.ZOMA_OPEN_TESTER_UNTIL = '2000-01-01T00:00:00Z'; };

  it('a new signup gets an approved, seat-exempt row without touching the counter; later admission sees approved', async () => {
    openWindow();
    const fake = fakeWaitlist();
    const m = await loadAdmission(fake);
    expect(await m.admitZomaSignup('New@X.co', noInvite)).toBe('approved');
    expect(fake.rows['new@x.co']).toMatchObject({ zomaStatus: 'approved', seatExempt: 'open_window', approvedBy: 'system:open-window' });
    closeWindow();
    expect(await m.admitZoma('new@x.co')).toBe('approved');
    expect(fake.transactWrite).not.toHaveBeenCalled();
    expect(fake.rows.__zoma_free_capacity__.approvedCount).toBe(5);
  });

  it('a waitlisted applicant is moved to approved durably, so after the window they are not waitlisted again', async () => {
    openWindow();
    const fake = fakeWaitlist({ 'w@x.co': { zomaStatus: 'waitlisted', joinedAt: '2026-11-20T00:00:00Z' } });
    const m = await loadAdmission(fake);
    expect(await m.admitZomaSignup('w@x.co', noInvite)).toBe('approved');
    expect(fake.rows['w@x.co']).toMatchObject({ zomaStatus: 'approved', seatExempt: 'open_window', joinedAt: '2026-11-20T00:00:00Z' });
    closeWindow();
    expect(await m.admitZoma('w@x.co')).toBe('approved');
    expect(fake.transactWrite).not.toHaveBeenCalled();
  });

  it('a rejected applicant stays rejected during the window', async () => {
    openWindow();
    const fake = fakeWaitlist({ 'r@x.co': { zomaStatus: 'rejected', rejectedBy: 'admin' } });
    const m = await loadAdmission(fake);
    expect(await m.admitZomaSignup('r@x.co', noInvite)).toBe('rejected');
    expect(fake.rows['r@x.co']).toEqual({ zomaStatus: 'rejected', rejectedBy: 'admin' });
  });

  it('production today (flag off), before Dec 3: a new signup takes a capped seat as on main', async () => {
    delete process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED;
    delete process.env.ZOMA_OPEN_TESTER_UNTIL;
    const fake = fakeWaitlist();
    const m = await loadAdmission(fake);
    expect(await m.admitZomaSignup('fresh@x.co', noInvite)).toBe('approved');
    expect(fake.transactWrite).toHaveBeenCalledTimes(1);
    expect(fake.rows.__zoma_free_capacity__.approvedCount).toBe(6);
  });
});

describe('Databricks seat exemption is dark without the flag', () => {
  afterEach(() => { jest.resetModules(); jest.dontMock('aws-sdk'); });
  it('returns databricks only when ZOMA_DATABRICKS_LAUNCH_ENABLED=true', async () => {
    const m = await loadAdmission(fakeWaitlist());
    process.env.ZOMA_OPEN_TESTER_UNTIL = '2000-01-01T00:00:00Z';
    delete process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED;
    expect(await m.zomaSeatExemption('buyer@acme-retail.com', noInvite, { databricks: true })).toBeNull();
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    expect(await m.zomaSeatExemption('buyer@acme-retail.com', noInvite, { databricks: true })).toBe('databricks');
  });
});
