/**
 * ENG-2782 S1 — Cloudflare Turnstile verification for the public Slack-start
 * intake. The backend had no reusable server-side captcha verifier (the
 * reCAPTCHA code in routes/landingPageGeneration.ts only manages a generated
 * site's Vercel env vars), so this is the minimal siteverify client.
 *
 * Fail closed: an unconfigured secret rejects every request unless NODE_ENV is
 * explicitly `development` or `test`. Production does not set NODE_ENV, so
 * "anything but development" has to be the closed branch.
 *
 * Env:
 *   SLACK_START_TURNSTILE_SECRET_KEY — server secret (never sent to browsers)
 *   SLACK_START_TURNSTILE_SITE_KEY   — public site key served in the wizard config
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: { method: string; body: URLSearchParams; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

export type CaptchaResult = { ok: true } | { ok: false; reason: 'missing_token' | 'rejected' | 'unconfigured' | 'unavailable' };

export interface CaptchaDeps {
  env?: Env;
  fetch?: FetchLike;
}

export function captchaPublicConfig(env: Env = process.env): { provider: 'turnstile'; siteKey: string } | null {
  const siteKey = env.SLACK_START_TURNSTILE_SITE_KEY?.trim();
  return siteKey ? { provider: 'turnstile', siteKey } : null;
}

export async function verifySlackStartCaptcha(
  token: unknown,
  remoteIp: string | undefined,
  deps: CaptchaDeps = {},
): Promise<CaptchaResult> {
  const env = deps.env ?? process.env;
  const secret = env.SLACK_START_TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    return env.NODE_ENV === 'development' || env.NODE_ENV === 'test' ? { ok: true } : { ok: false, reason: 'unconfigured' };
  }
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) return { ok: false, reason: 'missing_token' };

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await doFetch(SITEVERIFY_URL, { method: 'POST', body, signal: controller.signal });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const payload = (await res.json()) as { success?: unknown };
    return payload?.success === true ? { ok: true } : { ok: false, reason: 'rejected' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
