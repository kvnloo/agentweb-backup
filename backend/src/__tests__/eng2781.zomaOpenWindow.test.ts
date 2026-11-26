/** ENG-2781 seat option (a): flagged open tester window + Databricks seat exemption. */
import { zomaOpenTesterWindowActive, DEFAULT_ZOMA_OPEN_TESTER_UNTIL } from '../services/zomaOpenWindow';

const BEFORE = Date.parse('2026-12-02T12:00:00Z');
const AFTER = Date.parse('2026-12-03T09:00:00Z');
const on = { ZOMA_DATABRICKS_LAUNCH_ENABLED: 'true' } as NodeJS.ProcessEnv;

describe('zomaOpenTesterWindowActive', () => {
  it('is off without the flag, even before the end date', () => {
    expect(zomaOpenTesterWindowActive(BEFORE, {} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('is on with the flag before the default end (Dec 3 00:00 PT) and off after', () => {
    expect(DEFAULT_ZOMA_OPEN_TESTER_UNTIL).toBe('2026-12-03T08:00:00Z');
    expect(zomaOpenTesterWindowActive(BEFORE, on)).toBe(true);
    expect(zomaOpenTesterWindowActive(AFTER, on)).toBe(false);
  });
  it('honours ZOMA_OPEN_TESTER_UNTIL and fails closed on garbage', () => {
    expect(zomaOpenTesterWindowActive(AFTER, { ...on, ZOMA_OPEN_TESTER_UNTIL: '2026-12-10T00:00:00Z' })).toBe(true);
    expect(zomaOpenTesterWindowActive(BEFORE, { ...on, ZOMA_OPEN_TESTER_UNTIL: 'nope' })).toBe(false);
  });
});

describe('assertZomaPublishAllowed during the open window', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });
  it('skips the paywall (no billing) only while the flagged window is open', async () => {
    const { assertZomaPublishAllowed } = await import('../mcp/zomaBilling');
    const findCustomerId = jest.fn().mockRejectedValue(new Error('should not read plan'));
    const deps: any = { config: () => ({ enabled: true }), now: () => BEFORE, findCustomerId, listSubscriptions: jest.fn() };
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    delete process.env.ZOMA_OPEN_TESTER_UNTIL;
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, deps)).resolves.toBeUndefined();
    expect(findCustomerId).not.toHaveBeenCalled();
    deps.now = () => AFTER;
    await expect(assertZomaPublishAllowed('u1', { platform: 'meta' }, deps)).rejects.toThrow();
  });
});

describe('open-window admission is durable (review gap b)', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.resetModules(); jest.dontMock('aws-sdk'); });
  it('writes an approved, seat-exempt row without touching the counter; a later admitZoma sees approved', async () => {
    jest.resetModules();
    jest.dontMock('../services/zomaAdmission');
    const rows: Record<string, any> = {};
    const update = jest.fn((p: any) => ({ promise: async () => {
      if (rows[p.Key.email]?.zomaStatus) { const e: any = new Error('c'); e.code = 'ConditionalCheckFailedException'; throw e; }
      rows[p.Key.email] = { zomaStatus: p.ExpressionAttributeValues[':approved'], seatExempt: p.ExpressionAttributeValues[':exempt'] };
    } }));
    const get = jest.fn((p: any) => ({ promise: async () => ({ Item: rows[p.Key.email] }) }));
    const transactWrite = jest.fn();
    jest.doMock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => ({ update, get, transactWrite })) } } }));
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    process.env.ZOMA_OPEN_TESTER_UNTIL = '2999-01-01T00:00:00Z';
    const m = await import('../services/zomaAdmission');
    expect(await m.admitZomaSignup('New@X.co', { hasPendingOrgInvite: async () => false })).toBe('approved');
    expect(rows['new@x.co']).toEqual({ zomaStatus: 'approved', seatExempt: 'open_window' });
    process.env.ZOMA_OPEN_TESTER_UNTIL = '2000-01-01T00:00:00Z';
    expect(await m.admitZoma('new@x.co')).toBe('approved');
    expect(transactWrite).not.toHaveBeenCalled();
  });
});

describe('Databricks seat exemption is dark without the flag', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; jest.resetModules(); jest.dontMock('aws-sdk'); });
  it('returns databricks only when ZOMA_DATABRICKS_LAUNCH_ENABLED=true', async () => {
    jest.resetModules();
    jest.dontMock('../services/zomaAdmission');
    const get = jest.fn(() => ({ promise: async () => ({ Item: undefined }) }));
    jest.doMock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => ({ get, update: jest.fn(), transactWrite: jest.fn() })) } } }));
    const m = await import('../services/zomaAdmission');
    const deps = { hasPendingOrgInvite: async () => false };
    process.env.ZOMA_OPEN_TESTER_UNTIL = '2000-01-01T00:00:00Z';
    delete process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED;
    expect(await m.zomaSeatExemption('buyer@acme-retail.com', deps, { databricks: true })).toBeNull();
    process.env.ZOMA_DATABRICKS_LAUNCH_ENABLED = 'true';
    expect(await m.zomaSeatExemption('buyer@acme-retail.com', deps, { databricks: true })).toBe('databricks');
  });
});
