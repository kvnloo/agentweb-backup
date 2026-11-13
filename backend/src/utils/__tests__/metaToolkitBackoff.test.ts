import { parseBusinessUseCaseUsage } from '../metaBusinessUsage';
import axios from 'axios';
import { fetchWithRetry } from '../metaApiFetch';
import { withMetaToolkitBackoff, attachMetaToolkitBackoff, META_TOOLKIT_MAX_BACKOFF_MS } from '../metaToolkitBackoff';

const url = 'https://graph.facebook.com/v25.0/act_1/campaigns';
const response = (pct: number, data: any = { data: [{ id: '1' }] }, minutes = 2) => ({
  ok: !data.error, status: data.error ? 400 : 200,
  headers: { get: () => JSON.stringify({ '1': [{ call_count: 1, total_cputime: pct, total_time: 2, estimated_time_to_regain_access: minutes }] }) },
  json: async () => data, clone() { return this; },
}) as unknown as Response;

describe('toolkit BUC bounded backoff', () => {
  it('uses maxima across every BUC entry and handles malformed or absent headers', () => {
    expect(parseBusinessUseCaseUsage({ headers: { get: () => JSON.stringify({ a: [{ call_count: 2 }], b: [{ total_cputime: 96, estimated_time_to_regain_access: 3 }, { total_time: 99 }] }) } }))
      .toEqual({ callCountPct: 2, totalCpuTimePct: 96, totalTimePct: 99, estimatedMinutesToRegainAccess: 3 });
    expect(parseBusinessUseCaseUsage({})).toBeUndefined();
    expect(parseBusinessUseCaseUsage({ headers: { get: () => 'bad json' } })).toBeUndefined();
  });
  const original = global.fetch;
  let mocked: jest.Mock;
  let sleep: jest.Mock;
  beforeEach(() => { mocked = jest.fn(); global.fetch = mocked; sleep = jest.fn().mockResolvedValue(undefined); });
  afterEach(() => { global.fetch = original; });
  const run = (write = false) => withMetaToolkitBackoff(write, sleep, async () => (await fetchWithRetry(url)).json());
  it('passes through under threshold without sleeping', async () => {
    mocked.mockResolvedValue(response(89));
    expect(await run()).toEqual({ data: [{ id: '1' }] });
    expect(mocked).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });
  it('retries a high-usage read once then succeeds with capped minute conversion', async () => {
    mocked.mockResolvedValueOnce(response(90)).mockResolvedValueOnce(response(5));
    expect(await run()).toEqual({ data: [{ id: '1' }] });
    expect(mocked).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledWith(META_TOOLKIT_MAX_BACKOFF_MS);
  });
  it('returns readable rate limit at retry cap', async () => {
    mocked.mockResolvedValue(response(100));
    expect(await run()).toMatchObject({ success: false, rate_limited: true, estimated_time_to_regain_access: 2, message: expect.stringContaining('Retry later') });
    expect(mocked).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('never retries a write', async () => {
    mocked.mockResolvedValue(response(100));
    expect(await run(true)).toMatchObject({ rate_limited: true });
    expect(mocked).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  });
  it.each([4, 17, 32, 613, ...Array.from({ length: 15 }, (_, i) => 80000 + i)])('recognizes throttle code %i below threshold', async code => {
    mocked.mockResolvedValueOnce(response(1, { error: { code } }, 0.1)).mockResolvedValueOnce(response(1));
    expect(await run()).toEqual({ data: [{ id: '1' }] });
    expect(sleep).toHaveBeenCalledWith(6000); expect(mocked).toHaveBeenCalledTimes(2);
  });
  it('does not affect unrelated fetch helper calls outside toolkit context', async () => {
    mocked.mockResolvedValue(response(100));
    expect(await (await fetchWithRetry(url)).json()).toEqual({ data: [{ id: '1' }] });
    expect(mocked).toHaveBeenCalledTimes(1);
  });
  it('observes axios reads and shares one retry budget with fetch', async () => {
    let calls = 0;
    const adapter = async (config: any) => ({ config, data: { data: [] }, status: 200, statusText: 'OK', headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ total_time: ++calls === 1 ? 95 : 5 }] }) } });
    const result = await withMetaToolkitBackoff(false, sleep, async () => (await axios.get(url, { adapter })).data);
    expect(result).toEqual({ data: [] }); expect(calls).toBe(2); expect(sleep).toHaveBeenCalledTimes(1);
  });
  it('does not claim a write may have executed when only a preview read was throttled', async () => {
    mocked.mockResolvedValue(response(100));
    const result: any = await run(true);
    expect(result).toMatchObject({ rate_limited: true }); expect(result.message).not.toContain('may have executed');
  });
  it('warns that a throttled sent write may have executed', async () => {
    const adapter = async (config: any) => ({ config, data: {}, status: 200, statusText: 'OK', headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ total_time: 99 }] }) } });
    const result: any = await withMetaToolkitBackoff(true, sleep, async () => (await axios.post(url, {}, { adapter })).data);
    expect(result.message).toContain('may have executed'); expect(sleep).not.toHaveBeenCalled();
  });
  it('applies to dedicated axios instances (lifecycle guard reads)', async () => {
    let calls = 0;
    const client = attachMetaToolkitBackoff(axios.create());
    const adapter = async (config: any) => ({ config, data: { data: [] }, status: 200, statusText: 'OK', headers: { 'x-business-use-case-usage': JSON.stringify({ '1': [{ total_time: 100 }] }) } });
    const result = await withMetaToolkitBackoff(false, sleep, async () => { calls++; return (await client.get(url, { adapter: async (c: any) => { calls++; return adapter(c); } })).data; });
    expect(result).toMatchObject({ rate_limited: true, estimated_time_to_regain_access: expect.any(Number) });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
