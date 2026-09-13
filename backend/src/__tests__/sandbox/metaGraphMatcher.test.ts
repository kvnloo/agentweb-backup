import { classifyGraphRequest, hydrateMultipartFiles, isGraphHost } from '../../services/sandbox/metaGraphMatcher';
import { mintSandboxToken } from '../../services/sandbox/sentinel';

/**
 * ENG-1908: the matcher decides, synchronously and without ever throwing, whether a
 * Graph request belongs to a sandbox principal. Real traffic must be untouched.
 */
const USER = 'eval_0f1e2d3c-1111-4222-8333-444455556666';
const SBX = mintSandboxToken(USER);
const REAL = 'EAABsbCS1iHgBAO7ZCZCrealtoken';
const HOSTS = ['graph.facebook.com', 'graph-video.facebook.com'];
const VERSIONS = ['v24.0', 'v25.0'];

function simulate(result: ReturnType<typeof classifyGraphRequest>) {
  expect(result.kind).toBe('simulate');
  if (result.kind !== 'simulate') throw new Error('unreachable');
  return result.request;
}

describe('host and version gating', () => {
  it('is a passthrough for any non-Graph host without inspecting the body', () => {
    const untouchable = new Proxy({}, { get() { throw new Error('body was touched'); }, has() { throw new Error('body was touched'); } });
    expect(classifyGraphRequest({ url: `https://api.example.com/v25.0/act_1/campaigns?access_token=${SBX}`, body: untouchable })).toEqual({ kind: 'passthrough' });
    expect(classifyGraphRequest({ url: `http://127.0.0.1:3001/api/meta/ad-performance?access_token=${SBX}`, body: untouchable })).toEqual({ kind: 'passthrough' });
    expect(isGraphHost('https://api.example.com/x')).toBe(false);
    expect(isGraphHost('https://graph.facebook.com/v25.0/me')).toBe(true);
  });
  it('is a passthrough for garbage and non-URL input', () => {
    expect(classifyGraphRequest({ url: 'not a url' })).toEqual({ kind: 'passthrough' });
    expect(classifyGraphRequest({ url: '' })).toEqual({ kind: 'passthrough' });
    expect(classifyGraphRequest({ url: 'https://graph.facebook.com' })).toEqual({ kind: 'passthrough' });
  });
  it('is a passthrough for a real token on every host and version', () => {
    for (const host of HOSTS) for (const v of VERSIONS) {
      expect(classifyGraphRequest({ url: `https://${host}/${v}/act_1358071355944019/campaigns?fields=id,name&access_token=${REAL}` })).toEqual({ kind: 'passthrough' });
    }
  });
  it('is a passthrough for a Graph request with no token at all', () => {
    expect(classifyGraphRequest({ url: 'https://graph.facebook.com/v25.0/act_1/campaigns?fields=id' })).toEqual({ kind: 'passthrough' });
  });
  it('rejects a sandbox-prefixed token whose principal does not parse', () => {
    const r = classifyGraphRequest({ url: 'https://graph.facebook.com/v25.0/act_1/campaigns?access_token=sbx.not-an-eval-user.zz' });
    expect(r.kind).toBe('reject');
  });
});

describe('token sources', () => {
  it.each(HOSTS.flatMap(host => VERSIONS.map(v => [host, v])))('query access_token on %s %s', (host, v) => {
    const req = simulate(classifyGraphRequest({ url: `https://${host}/${v}/act_1207000000000001/campaigns?fields=id%2Cname&limit=100&access_token=${SBX}`, method: 'get' }));
    expect(req).toMatchObject({ userId: USER, token: SBX, method: 'GET', version: v, path: 'act_1207000000000001/campaigns', query: { fields: 'id,name', limit: '100' } });
    expect(req.query.access_token).toBeUndefined();
  });
  it('Authorization: Bearer', () => {
    const req = simulate(classifyGraphRequest({ url: 'https://graph.facebook.com/v25.0/me/adaccounts?fields=id', headers: { Authorization: `Bearer ${SBX}` } }));
    expect(req.path).toBe('me/adaccounts');
    expect(req.userId).toBe(USER);
  });
  it('form body as a string, URLSearchParams and Buffer', () => {
    const ct = 'application/x-www-form-urlencoded';
    for (const body of [`name=Proposal&objective=OUTCOME_LEADS&access_token=${SBX}`, new URLSearchParams({ name: 'Proposal', objective: 'OUTCOME_LEADS', access_token: SBX }), Buffer.from(`name=Proposal&objective=OUTCOME_LEADS&access_token=${SBX}`)]) {
      const req = simulate(classifyGraphRequest({ url: 'https://graph.facebook.com/v24.0/act_1207000000000001/campaigns', method: 'POST', contentType: ct, body }));
      expect(req.method).toBe('POST');
      expect(req.form).toEqual({ name: 'Proposal', objective: 'OUTCOME_LEADS' });
    }
  });
  it('JSON body (the SDK posts params as JSON; the token may ride along)', () => {
    const req = simulate(classifyGraphRequest({ url: 'https://graph.facebook.com/v24.0/act_1207000000000001/adsets', method: 'post', contentType: 'application/json', body: JSON.stringify({ name: 'Set', access_token: SBX }) }));
    expect(req.json).toEqual({ name: 'Set' });
    expect(req.form).toBeUndefined();
  });
  it('multipart/form-data as a raw Buffer with a boundary', () => {
    const boundary = '----sbxboundary42';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\nad.jpg\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${SBX}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ad.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = simulate(classifyGraphRequest({ url: 'https://graph.facebook.com/v25.0/act_1207000000000001/adimages', method: 'POST', contentType: `multipart/form-data; boundary=${boundary}`, body }));
    expect(req.multipart?.fields).toEqual({ filename: 'ad.jpg' });
    expect(req.multipart?.files).toHaveLength(1);
    expect(req.multipart?.files[0]).toMatchObject({ field: 'file', filename: 'ad.jpg', contentType: 'image/jpeg' });
    expect(Buffer.compare(req.multipart!.files[0].bytes, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe(0);
  });
  it('global FormData with a File part (the raw adimages route), hydrated asynchronously', async () => {
    const fd = new FormData();
    fd.append('filename', 'ad.png');
    fd.append('access_token', SBX);
    fd.append('file', new Blob([Buffer.from([1, 2, 3, 4])], { type: 'image/png' }), 'ad.png');
    const req = simulate(classifyGraphRequest({ url: 'https://graph.facebook.com/v25.0/act_1207000000000001/adimages', method: 'POST', body: fd }));
    expect(req.multipart?.fields).toEqual({ filename: 'ad.png' });
    expect(req.multipart?.files[0]).toMatchObject({ field: 'file', filename: 'ad.png', contentType: 'image/png' });
    await hydrateMultipartFiles(req);
    expect(Buffer.compare(req.multipart!.files[0].bytes, Buffer.from([1, 2, 3, 4]))).toBe(0);
  });
  it('fb_exchange_token and input_token (refresh and debug calls)', () => {
    const a = simulate(classifyGraphRequest({ url: `https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=1&client_secret=s&fb_exchange_token=${SBX}` }));
    expect(a.path).toBe('oauth/access_token');
    expect(a.query.grant_type).toBe('fb_exchange_token');
    const b = simulate(classifyGraphRequest({ url: `https://graph.facebook.com/v25.0/debug_token?input_token=${SBX}&access_token=${SBX}` }));
    expect(b.path).toBe('debug_token');
  });
  it('an unversioned Graph path with a sandbox token still simulates (fail closed), without one passes through', () => {
    expect(classifyGraphRequest({ url: `https://graph.facebook.com/oauth/access_token?fb_exchange_token=${SBX}` }).kind).toBe('simulate');
    expect(classifyGraphRequest({ url: `https://graph.facebook.com/oauth/access_token?fb_exchange_token=${REAL}` })).toEqual({ kind: 'passthrough' });
  });
  it('maps PUT to POST and HEAD to GET, and strips a trailing slash from the path', () => {
    expect(simulate(classifyGraphRequest({ url: `https://graph.facebook.com/v25.0/120210000000000001/?access_token=${SBX}`, method: 'PUT' })).method).toBe('POST');
    expect(simulate(classifyGraphRequest({ url: `https://graph.facebook.com/v25.0/120210000000000001/?access_token=${SBX}`, method: 'HEAD' }))).toMatchObject({ method: 'GET', path: '120210000000000001' });
  });
  it('a malformed body on a sandbox request rejects instead of leaking', () => {
    const r = classifyGraphRequest({ url: 'https://graph.facebook.com/v25.0/act_1/adimages', method: 'POST', contentType: 'multipart/form-data; boundary=zzz', body: { get length() { throw new Error('boom'); } } });
    // No sandbox token was seen, so this is a passthrough (fail open for real traffic) ...
    expect(r.kind).toBe('passthrough');
    // ... but once a sandbox token IS present, a parse failure must not let the request out.
    const r2 = classifyGraphRequest({ url: `https://graph.facebook.com/v25.0/act_1/adimages?access_token=${SBX}`, method: 'POST', contentType: 'multipart/form-data; boundary=zzz', body: { get length() { throw new Error('boom'); } } });
    expect(r2.kind).toBe('reject');
  });
});
