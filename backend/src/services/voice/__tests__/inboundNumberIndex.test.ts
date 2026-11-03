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

  it('rescans once the snapshot is older than 60 seconds and sees a number added meanwhile', async () => {
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBeNull();
    scan.mockResolvedValue([{ orgId: 'org-c', twilioNumber: '+14155550113' }]);
    now += 59_999;
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBeNull();
    now += 1;
    await expect(findOrgIdByCallerNumber('+14155550113')).resolves.toBe('org-c');
    expect(scan).toHaveBeenCalledTimes(2);
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

  it('propagates a failed scan and does not cache the failure', async () => {
    scan.mockRejectedValueOnce(new Error('throttled'));
    await expect(findOrgIdByCallerNumber(A)).rejects.toThrow('throttled');
    await expect(findOrgIdByCallerNumber(A)).resolves.toBe('org-a');
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
