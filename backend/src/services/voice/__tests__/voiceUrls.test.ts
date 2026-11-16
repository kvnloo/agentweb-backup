import { buildInboundWebhookUrl, buildVoiceWebhookUrl, inboundVoiceUrl, isWebhookSafeId, voiceWebhookBaseUrl } from '../voiceUrls';

const ctx = { listId: 'list 1', leadId: 'lead&id=2', jobKey: 'a/b?c#d' };

describe('buildVoiceWebhookUrl', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it.each(['owner', 'gather', 'dial', 'status', 'screen', 'screen-result'] as const)('builds the %s URL on the twilio-voice mount from BACKEND_URL', (kind) => {
    process.env.BACKEND_URL = 'https://api.example.com';
    const url = new URL(buildVoiceWebhookUrl(kind, { listId: 'l1', leadId: 'ld1', jobKey: 'j1' }));
    expect(url.origin + url.pathname).toBe(`https://api.example.com/api/webhooks/twilio-voice/${kind}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ listId: 'l1', leadId: 'ld1', jobKey: 'j1' });
  });

  it('URL-encodes values so they round-trip and cannot inject parameters', () => {
    process.env.BACKEND_URL = 'https://api.example.com';
    const url = new URL(buildVoiceWebhookUrl('owner', ctx));
    expect(Object.fromEntries(url.searchParams)).toEqual(ctx);
    expect([...url.searchParams.keys()]).toEqual(['listId', 'leadId', 'jobKey']);
    expect(url.hash).toBe('');
  });

  it('tolerates a trailing slash and whitespace on BACKEND_URL', () => {
    process.env.BACKEND_URL = '  https://api.example.com//  ';
    expect(buildVoiceWebhookUrl('status', { listId: 'l', leadId: 'd', jobKey: 'j' })).toMatch(/^https:\/\/api\.example\.com\/api\/webhooks\/twilio-voice\/status\?/);
  });

  it.each(['production', 'staging', 'preview', 'Production'])('throws for NODE_ENV=%s when BACKEND_URL is unset or blank (fail closed)', (nodeEnv) => {
    Object.assign(process.env, { NODE_ENV: nodeEnv });
    delete process.env.BACKEND_URL;
    expect(() => buildVoiceWebhookUrl('owner', ctx)).toThrow(/BACKEND_URL/);
    process.env.BACKEND_URL = '   ';
    expect(() => buildVoiceWebhookUrl('owner', ctx)).toThrow(/BACKEND_URL/);
  });

  it.each(['development', 'test'])('falls back to localhost for NODE_ENV=%s, like the repo\'s other callback URLs', (nodeEnv) => {
    Object.assign(process.env, { NODE_ENV: nodeEnv });
    delete process.env.BACKEND_URL;
    expect(buildVoiceWebhookUrl('owner', ctx)).toMatch(/^http:\/\/localhost:3001\/api\/webhooks\/twilio-voice\/owner\?/);
  });

  it('falls back to localhost when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;
    delete process.env.BACKEND_URL;
    expect(buildVoiceWebhookUrl('owner', ctx)).toMatch(/^http:\/\/localhost:3001\//);
  });

  it('uses BACKEND_URL in any environment when it is set', () => {
    Object.assign(process.env, { NODE_ENV: 'staging' });
    process.env.BACKEND_URL = 'https://staging.example.com';
    expect(buildVoiceWebhookUrl('owner', ctx)).toMatch(/^https:\/\/staging\.example\.com\//);
  });
});

describe('status callback retry override', () => {
  beforeEach(() => { process.env.BACKEND_URL = 'https://api.example.com'; });

  it('puts the documented retry fragment on status URLs only', () => {
    const c = { listId: 'l', leadId: 'd', jobKey: 'j' };
    expect(buildVoiceWebhookUrl('status', c)).toMatch(/\?listId=l&leadId=d&jobKey=j#rc=3&rp=5xx,ct$/);
    for (const kind of ['owner', 'gather', 'dial', 'screen', 'screen-result'] as const) expect(buildVoiceWebhookUrl(kind, c)).not.toContain('#');
  });

  it('adds leg=lead to the query, before the fragment', () => {
    const url = buildVoiceWebhookUrl('status', { listId: 'l', leadId: 'd', jobKey: 'j' }, { leg: 'lead' });
    expect(url).toMatch(/\?listId=l&leadId=d&jobKey=j&leg=lead#rc=3&rp=5xx,ct$/);
    expect(new URL(url).searchParams.get('leg')).toBe('lead');
  });
});

describe('voiceWebhookBaseUrl', () => {
  it('returns the configured origin without trailing slashes and refuses an unset base in staging', () => {
    process.env.BACKEND_URL = ' https://api.example.com// ';
    expect(voiceWebhookBaseUrl()).toBe('https://api.example.com');
    delete process.env.BACKEND_URL;
    Object.assign(process.env, { NODE_ENV: 'staging' });
    expect(() => voiceWebhookBaseUrl()).toThrow(/BACKEND_URL/);
  });
});

describe('isWebhookSafeId', () => {
  it.each(['list-1', 'a_b.c:d', 'x'.repeat(200), '0f8fad5b-d9cb-469f-a165-70867728950e'])('accepts %s', (id) => {
    expect(isWebhookSafeId(id)).toBe(true);
  });
  it.each(['', 'a@b.com', 'a+b', 'a b', 'a/b', 'a?b', 'a&b', 'x'.repeat(201), 'é'])('rejects %j', (id) => {
    expect(isWebhookSafeId(id)).toBe(false);
  });
});

describe('inbound callback URLs', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('the number voice URL is the inbound entry point with no query', () => {
    process.env.BACKEND_URL = 'https://api.example.com/';
    expect(inboundVoiceUrl()).toBe('https://api.example.com/api/webhooks/twilio-voice/inbound');
  });

  it('throws when BACKEND_URL is missing in a deployed environment, so a purchase never starts without it', () => {
    delete process.env.BACKEND_URL;
    Object.assign(process.env, { NODE_ENV: 'production' });
    expect(() => inboundVoiceUrl()).toThrow(/BACKEND_URL/);
  });

  it.each(['inbound-screen', 'inbound-screen-result', 'inbound-dial', 'inbound-status'] as const)('builds the %s URL with only the org and the members tried', (kind) => {
    process.env.BACKEND_URL = 'https://api.example.com';
    const url = new URL(buildInboundWebhookUrl(kind, { orgId: 'org-a', tried: ['maaaaaaa', 'mbbbbbbb'] }));
    expect(url.origin + url.pathname).toBe(`https://api.example.com/api/webhooks/twilio-voice/${kind}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ orgId: 'org-a', tried: 'maaaaaaa,mbbbbbbb' });
    expect(url.hash).toBe(kind === 'inbound-status' ? '#rc=3&rp=5xx,ct' : '');
  });
});
