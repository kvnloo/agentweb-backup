import http from 'http';
import https from 'https';
import axios from 'axios';
import * as matcher from '../../services/sandbox/metaGraphMatcher';
import { installMetaSandboxInterceptor, uninstallMetaSandboxInterceptor, getInterceptorAudit, resetInterceptorAuditForTests } from '../../services/sandbox/metaInterceptor';
import { mintSandboxToken } from '../../services/sandbox/sentinel';
import type { SimRequest, SimResponse } from '../../services/sandbox/types';

/**
 * ENG-1908: one process-level interceptor answers sandbox-token Graph calls for every HTTP
 * client the backend uses (global fetch, the shared axios instance the Meta SDK rides on,
 * and raw http/https as a fail-closed backstop) while real traffic passes through untouched.
 * No external egress: passthrough is proven against a local server.
 */
const USER = 'eval_0f1e2d3c-1111-4222-8333-444455556666';
const SBX = mintSandboxToken(USER);
const SBX24 = `https://graph.facebook.com/v24.0/act_1207000000000001/adsets?fields=id&access_token=${SBX}`;
const SBX25 = `https://graph.facebook.com/v25.0/act_1207000000000001/campaigns?fields=id%2Cname&access_token=${SBX}`;

const seen: SimRequest[] = [];
const handle = jest.fn(async (req: SimRequest): Promise<SimResponse> => {
  seen.push(req);
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: '120210000000000001', name: 'Simulated', account_id: '1207000000000001' }], paging: { cursors: { before: 'a', after: 'b' } }, path: req.path, method: req.method }) };
});

let server: http.Server; let local: string;
const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const originalHttpGet = http.get;
const originalHttpsGet = https.get;
const originalAdapter = axios.getAdapter(axios.defaults.adapter);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ real: true, method: req.method, url: req.url, echo: body })); });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  local = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { uninstallMetaSandboxInterceptor(); await new Promise(r => server.close(r)); });
beforeEach(() => { uninstallMetaSandboxInterceptor(); resetInterceptorAuditForTests(); seen.length = 0; handle.mockClear(); installMetaSandboxInterceptor({ handle }); });

describe('global fetch', () => {
  it('simulates a sandbox request given as a string, a URL and a Request', async () => {
    for (const input of [SBX25, new URL(SBX25), new Request(SBX25)]) {
      const res = await fetch(input as any);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      const json = await res.json();
      expect(json.data[0].name).toBe('Simulated');
      expect(json.path).toBe('act_1207000000000001/campaigns');
    }
    expect(handle).toHaveBeenCalledTimes(3);
    expect(getInterceptorAudit().simulated).toBe(3);
  });
  it('passes real traffic through byte-for-byte without even classifying it', async () => {
    const spy = jest.spyOn(matcher, 'classifyGraphRequest');
    const res = await fetch(`${local}/anything?access_token=${SBX}`, { method: 'POST', body: 'x=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const json = await res.json();
    expect(json).toMatchObject({ real: true, method: 'POST', echo: 'x=1' });
    expect(spy).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('carries a form body and a FormData file into the SimRequest', async () => {
    await fetch(`https://graph.facebook.com/v25.0/act_1207000000000001/campaigns?access_token=${SBX}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Proposal&status=PAUSED' });
    expect(seen[0].form).toEqual({ name: 'Proposal', status: 'PAUSED' });
    const fd = new FormData();
    fd.append('filename', 'ad.png'); fd.append('access_token', SBX);
    fd.append('file', new Blob([Buffer.from([9, 8, 7])], { type: 'image/png' }), 'ad.png');
    await fetch('https://graph.facebook.com/v25.0/act_1207000000000001/adimages', { method: 'POST', body: fd });
    expect(seen[1].multipart?.fields).toEqual({ filename: 'ad.png' });
    expect(Buffer.compare(seen[1].multipart!.files[0].bytes, Buffer.from([9, 8, 7]))).toBe(0);
  });
  it('answers a malformed sandbox token with a Graph OAuth error and never calls the simulator', async () => {
    const res = await fetch('https://graph.facebook.com/v25.0/me?access_token=sbx.broken');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: 190, type: 'OAuthException' });
    expect(handle).not.toHaveBeenCalled();
    expect(getInterceptorAudit().rejected).toBe(1);
  });
});

describe('axios (the Meta SDK shares this instance)', () => {
  it('simulates GET at the SDK-pinned v24 and POST form / POST json', async () => {
    const get = await axios.get(SBX24);
    expect(get.status).toBe(200);
    expect(get.data.data[0].name).toBe('Simulated');
    expect(get.data.path).toBe('act_1207000000000001/adsets');
    const form = await axios.post(`https://graph.facebook.com/v25.0/act_1207000000000001/adsets?access_token=${SBX}`, new URLSearchParams({ name: 'Set', daily_budget: '5000' }));
    expect(form.status).toBe(200);
    expect(seen[1].form).toEqual({ name: 'Set', daily_budget: '5000' });
    const json = await axios.post(`https://graph.facebook.com/v24.0/act_1207000000000001/campaigns?access_token=${SBX}`, { name: 'Camp', objective: 'OUTCOME_LEADS' });
    expect(json.status).toBe(200);
    expect(seen[2].json).toEqual({ name: 'Camp', objective: 'OUTCOME_LEADS' });
    expect(seen[2].method).toBe('POST');
  });
  it('passes real traffic through to the original adapter', async () => {
    const res = await axios.post(`${local}/real`, 'a=b', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.data).toMatchObject({ real: true, echo: 'a=b' });
    expect(handle).not.toHaveBeenCalled();
  });
  it('throws an AxiosError for a non-2xx simulated status, like the real adapter would', async () => {
    handle.mockResolvedValueOnce({ status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }) });
    await expect(axios.get(SBX24)).rejects.toMatchObject({ isAxiosError: true, response: { status: 400, data: { error: { code: 100 } } } });
  });
  it('the http backstop still answers a client that bypasses the adapter hook, and audits it', async () => {
    const bypass = axios.create({ adapter: originalAdapter });
    const res = await bypass.get(SBX24);
    expect(res.data.data[0].name).toBe('Simulated');
    const audit = getInterceptorAudit();
    expect(audit.backstopHits).toBe(1);
    expect(audit.lastBackstop).toMatchObject({ method: 'GET', path: 'act_1207000000000001/adsets' });
    // and real traffic through the same client reaches the local server
    const real = await bypass.get(`${local}/bypass`);
    expect(real.data.real).toBe(true);
  });
});

describe('raw http/https backstop', () => {
  it('simulates a raw https.request with a callback', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(SBX25, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
      req.on('error', reject); req.end();
    });
    expect(JSON.parse(body).data[0].name).toBe('Simulated');
    expect(getInterceptorAudit().backstopHits).toBe(1);
  });
  it('passes a raw http.request to a real host through', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(`${local}/raw`, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
      req.on('error', reject); req.end();
    });
    expect(JSON.parse(body).real).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });
  // Node implements `get` as a module-local call to its internal `request`, not through the
  // exported `request` property — wrapping `.request` alone does not cover `.get` (CodeRabbit).
  it('simulates a raw https.get exactly like https.request', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.get(SBX25, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
      req.on('error', reject);
    });
    expect(JSON.parse(body).data[0].name).toBe('Simulated');
    expect(getInterceptorAudit().backstopHits).toBe(1);
  });
  it('passes a raw http.get to a real host through', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(`${local}/raw-get`, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
      req.on('error', reject);
    });
    expect(JSON.parse(body).real).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('turns a simulator exception into a Graph-shaped 500 and counts it', async () => {
    handle.mockRejectedValueOnce(new Error('dataset missing'));
    const res = await fetch(SBX25);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ code: 1, type: 'SandboxSimulatorError' });
    expect(getInterceptorAudit().simulatorErrors).toBe(1);
  });
  it('never hangs: a simulator that stalls is cut off by the timeout', async () => {
    uninstallMetaSandboxInterceptor();
    installMetaSandboxInterceptor({ handle: () => new Promise(() => undefined), timeoutMs: 60 });
    const started = Date.now();
    const res = await fetch(SBX25);
    expect(res.status).toBe(500);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(getInterceptorAudit().simulatorErrors).toBe(1);
  });
});

describe('lifecycle', () => {
  it('install is idempotent and uninstall restores the original clients', () => {
    const wrappedFetch = globalThis.fetch;
    installMetaSandboxInterceptor({ handle });
    expect(globalThis.fetch).toBe(wrappedFetch);
    uninstallMetaSandboxInterceptor();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(http.request).toBe(originalHttpRequest);
    expect(https.request).toBe(originalHttpsRequest);
    expect(http.get).toBe(originalHttpGet);
    expect(https.get).toBe(originalHttpsGet);
    expect(axios.getAdapter(axios.defaults.adapter)).toBe(originalAdapter);
  });
});
