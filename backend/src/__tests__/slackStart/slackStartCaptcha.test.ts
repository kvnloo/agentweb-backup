/**
 * ENG-2782 S1 — captcha for the public intake. No reusable server-side
 * verifier existed in the backend, so this is a Cloudflare Turnstile
 * siteverify client. Missing configuration FAILS CLOSED everywhere except an
 * explicit development/test NODE_ENV (production does not set NODE_ENV
 * explicitly — see app.ts's ngrok note — so "not development" must mean closed).
 */
import { verifySlackStartCaptcha, captchaPublicConfig } from '../../services/slackStart/slackStartCaptcha';

const okFetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
const rejectFetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }));

describe('verifySlackStartCaptcha', () => {
  it('verifies the token with Turnstile and forwards the visitor ip', async () => {
    const res = await verifySlackStartCaptcha('tok', '1.2.3.4', {
      env: { SLACK_START_TURNSTILE_SECRET_KEY: 'sec', NODE_ENV: 'production' },
      fetch: okFetch,
    });
    expect(res).toEqual({ ok: true });
    const [url, init] = okFetch.mock.calls[0] as unknown as [string, { method: string; body: URLSearchParams }];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    expect(init.body.get('secret')).toBe('sec');
    expect(init.body.get('response')).toBe('tok');
    expect(init.body.get('remoteip')).toBe('1.2.3.4');
  });

  it('rejects a token Turnstile does not accept', async () => {
    await expect(
      verifySlackStartCaptcha('bad', undefined, { env: { SLACK_START_TURNSTILE_SECRET_KEY: 'sec' }, fetch: rejectFetch }),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
  });

  it('rejects a missing token without calling Turnstile', async () => {
    const f = jest.fn();
    await expect(
      verifySlackStartCaptcha('', undefined, { env: { SLACK_START_TURNSTILE_SECRET_KEY: 'sec' }, fetch: f }),
    ).resolves.toEqual({ ok: false, reason: 'missing_token' });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([{ NODE_ENV: 'production' }, {}, { NODE_ENV: 'staging' }])('fails closed when unconfigured outside development (%p)', async (env) => {
    await expect(verifySlackStartCaptcha('tok', undefined, { env, fetch: okFetch })).resolves.toEqual({
      ok: false,
      reason: 'unconfigured',
    });
  });

  it('allows an unconfigured captcha only in explicit development/test', async () => {
    await expect(verifySlackStartCaptcha(undefined, undefined, { env: { NODE_ENV: 'development' } })).resolves.toEqual({ ok: true });
  });

  it('fails closed when Turnstile is unreachable', async () => {
    const boom = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      verifySlackStartCaptcha('tok', undefined, { env: { SLACK_START_TURNSTILE_SECRET_KEY: 'sec' }, fetch: boom }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('publishes only the site key to the browser', () => {
    expect(captchaPublicConfig({ SLACK_START_TURNSTILE_SITE_KEY: 'site', SLACK_START_TURNSTILE_SECRET_KEY: 'sec' })).toEqual({
      provider: 'turnstile',
      siteKey: 'site',
    });
    expect(captchaPublicConfig({})).toBeNull();
  });
});
