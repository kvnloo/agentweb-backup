jest.mock('../../db', () => ({ orgDb: { listHotLeadCallNumbers: jest.fn() } }));
import { orgDb } from '../../db';
import { findOrgIdByCallerNumber, resetInboundNumberIndexForTests } from '../inboundNumberIndex';

const scan = orgDb.listHotLeadCallNumbers as jest.Mock;
const A = '+14155550111';
const B = '+14155550112';
let now: number;
let nowSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.resetAllMocks();
  resetInboundNumberIndexForTests();
  now = 1_800_000_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  scan.mockResolvedValue([{ orgId: 'org-a', twilioNumber: A }, { orgId: 'org-b', twilioNumber: B }]);
});
afterEach(() => { nowSpy.mockRestore(); errorSpy.mockRestore(); });

describe('findOrgIdByCallerNumber', () => {
  it('finds the org that holds the number', async () => {
    await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-a');
    await expect(findOrgIdByCallerNumber(B)).resolves.toBe('org-b');
  });

  it('scans once for any number of lookups within the TTL, unknown numbers included (the negative cache)', async () => {
    for (let i = 0; i < 5; i++) {
      await findOrgIdByCallerNumber(A);
      await expect(findOrgIdByCallerNumber(`+1415555${String(2000 + i)}`)).resolves.toBeNull();
    }
    expect(scan).toHaveBeenCalledTimes(1);
  });

  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

  it('serves the stale snapshot once it is older than 60 seconds and refreshes it in the background', async () => {
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBeNull();
    scan.mockResolvedValue([{ orgId: 'org-c', twilioNumber: '+14155550113' }]);
    now += 59_999;
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBeNull();
    expect(scan).toHaveBeenCalledTimes(1);
    now += 1;
    // Answered from the stale snapshot, not from the scan the call triggers.
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBeNull();
    await settle();
    expect(scan).toHaveBeenCalledTimes(2);
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBe('org-c');
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not wait for the refresh: the call is answered while the scan is still running', async () => {
    await findOrgIdByCallerNumber(A);
    let finish!: (rows: unknown[]) => void;
    scan.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    now += 60_000;
    await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-a');
    await expect(findOrgIdByCallerNumber(B)).resolves.toBe('org-b');
    expect(scan).toHaveBeenCalledTimes(2); // one refresh in flight, shared
    finish([{ orgId: 'org-c', twilioNumber: A }]);
    await settle();
    await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-c');
  });

  it('keeps serving the stale snapshot when a refresh fails, logs only the error name, and retries no more than every 5 seconds', async () => {
    await findOrgIdByCallerNumber(A);
    scan.mockRejectedValue(Object.assign(new Error('secret detail'), { name: 'ThrottlingException' }));
    now += 60_000;
    for (let i = 0; i < 10; i++) await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-a');
    await settle();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('ThrottlingException');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret detail');
    now += 4_999;
    await findOrgIdByCallerNumber(A);
    await settle();
    expect(scan).toHaveBeenCalledTimes(2);
    now += 1;
    scan.mockResolvedValue([{ orgId: 'org-d', twilioNumber: A }]);
    await findOrgIdByCallerNumber(A);
    await settle();
    await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-d');
  });

  it('shares one scan between concurrent lookups', async () => {
    await Promise.all([findOrgIdByCallerNumber(A), findOrgIdByCallerNumber(B), findOrgIdByCallerNumber('+14155550199')]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('serves a number held by two orgs to neither, and says so', async () => {
    scan.mockResolvedValue([{ orgId: 'org-a', twilioNumber: A }, { orgId: 'org-b', twilioNumber: A }, { orgId: 'org-b', twilioNumber: B }]);
    await expect(findOrgIdByCallerNumber(A)).resolves.toBeNull();
    await expect(findOrgIdByCallerNumber(B)).resolves.toBe('org-b');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('4155550111');
  });

  it('ignores a stored value that is not a valid caller number', async () => {
    scan.mockResolvedValue([{ orgId: 'org-a', twilioNumber: '4155550111' }]);
    await expect(findOrgIdByCallerNumber('4155550111')).resolves.toBeNull();
  });

  it('a failed first scan (no snapshot) throws, is not cached, and the next lookup scans again', async () => {
    scan.mockRejectedValueOnce(new Error('throttled'));
    await expect(findOrgIdByCallerNumber(A)).rejects.toThrow('throttled');
    await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-a');
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('concurrent first lookups share one scan, including when it fails', async () => {
    scan.mockRejectedValueOnce(new Error('throttled'));
    const results = await Promise.allSettled([findOrgIdByCallerNumber(A), findOrgIdByCallerNumber(B)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
