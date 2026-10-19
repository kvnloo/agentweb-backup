import { buildVoiceWebhookUrl } from '../voiceUrls';

const ctx = { listId: 'list 1', leadId: 'lead&id=2', jobKey: 'a/b?c#d' };

describe('buildVoiceWebhookUrl', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it.each(['owner', 'gather', 'dial', 'status'] as const)('builds the %s URL on the twilio-voice mount from BACKEND_URL', (kind) => {
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
