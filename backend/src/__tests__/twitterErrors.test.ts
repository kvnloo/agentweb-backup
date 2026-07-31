import {
  describeXApiError,
  isXApiCreditsError,
  XCreditsExhaustedError,
} from '../utils/twitterErrors';

/**
 * Unit tests for describeXApiError — the AC#3 error-surfacing helper.
 * Behavioral contract: an X ApiResponseError's real title/detail/errors must be
 * surfaced, never collapsed to a bare "Request failed with code 403".
 */

// Mirror the real twitter-api-v2 ApiResponseError shape: HTTP status on `.code`,
// X's structured payload on `.data`, terse `.message`.
const makeApiResponseError = (code: number, data: any) =>
  Object.assign(new Error(`Request failed with code ${code}`), { code, data });

describe('describeXApiError', () => {
  it('surfaces X title + detail with the HTTP status (not the bare message)', () => {
    const err = makeApiResponseError(403, {
      title: 'Forbidden',
      detail:
        'Your client app is not configured with the appropriate oauth1 app permissions for this endpoint.',
      type: 'about:blank',
    });
    const msg = describeXApiError(err);
    expect(msg).toContain('Forbidden');
    expect(msg).toContain('appropriate oauth1 app permissions');
    expect(msg).toContain('403');
    expect(msg).not.toBe('Request failed with code 403');
  });

  it('surfaces messages from the nested errors[] array', () => {
    const err = makeApiResponseError(400, {
      errors: [{ message: 'Invalid tweet id' }, { detail: 'must be numeric' }],
    });
    const msg = describeXApiError(err);
    expect(msg).toContain('Invalid tweet id');
    expect(msg).toContain('must be numeric');
  });

  it('surfaces a bare `error` string field', () => {
    const err = makeApiResponseError(401, { error: 'Unauthorized token' });
    expect(describeXApiError(err)).toContain('Unauthorized token');
  });

  it('falls back to the error message when there is no X payload', () => {
    expect(describeXApiError(new Error('network down'))).toBe('network down');
  });

  it('falls back to the message when data is present but empty', () => {
    const err = makeApiResponseError(500, {});
    expect(describeXApiError(err)).toBe('Request failed with code 500');
  });

  it('handles a plain string', () => {
    expect(describeXApiError('boom')).toBe('boom');
  });

  it('handles a non-error, non-string value', () => {
    expect(describeXApiError({ weird: true })).toBe('Unknown error');
  });

  it('returns "Unknown error" for null / undefined without throwing', () => {
    // Exercises the `e?.data` nullish short-circuit — a nullish error must not
    // blow up the surfacing helper.
    expect(describeXApiError(null)).toBe('Unknown error');
    expect(describeXApiError(undefined)).toBe('Unknown error');
  });

  it('surfaces errors[].title and skips null / non-string error entries', () => {
    // A null entry and a numeric-`message` entry must be dropped (not stringified),
    // while a title-only entry is still surfaced via the message→detail→title fallback.
    const err = makeApiResponseError(401, {
      errors: [null, { title: 'Rate limit exceeded' }, { message: 9999 }] as any,
    });
    const msg = describeXApiError(err);
    expect(msg).toContain('Rate limit exceeded'); // title-only entry surfaced
    expect(msg).not.toContain('9999'); // numeric message entry dropped, not stringified
    expect(msg).toContain('401');
  });

  it('omits the HTTP-status prefix when code is not numeric', () => {
    const err = Object.assign(new Error('x'), { data: { title: 'Bad Request' } });
    const msg = describeXApiError(err);
    expect(msg).toContain('Bad Request');
    expect(msg).not.toContain('HTTP');
  });

  // ENG-604: HTTP 402 = AgentWeb's shared X Developer App is out of X API credits.
  // The plan/credit balance belongs to AgentWeb (every user connects against the
  // one shared app), NOT the end user — so the surfaced error must explain it is a
  // platform-side limit and route them to AgentWeb support, NOT tell them to top up
  // "their" plan or visit a Developer Portal they have no access to.
  it('explains an AgentWeb-side credit limit on a 402 credits-depleted error', () => {
    const err = makeApiResponseError(402, {
      title: 'Payment Required',
      detail: 'credits depleted',
    });
    const msg = describeXApiError(err);
    expect(msg).toContain('Payment Required');
    expect(msg).toContain('credits depleted');
    expect(msg).toContain('402');
    // Actionable AND correctly attributed: AgentWeb-side credit limit, contact support.
    expect(msg).toMatch(/credits/i);
    expect(msg).toMatch(/AgentWeb/);
    expect(msg).toMatch(/support/i);
    // Must NOT blame the user's own X account/plan or send them to the Developer Portal.
    expect(msg).not.toMatch(/your X \(Twitter\) API plan|your X app/i);
    expect(msg).not.toMatch(/developer\.x\.com|Developer Portal/i);
  });

  it('surfaces the credit-limit explanation on a 402 even when the X payload is empty', () => {
    const err = makeApiResponseError(402, {});
    const msg = describeXApiError(err);
    expect(msg).toMatch(/AgentWeb/);
    expect(msg).toMatch(/support/i);
    expect(msg).toContain('402');
    expect(msg).not.toBe('Request failed with code 402');
  });

  it('does NOT add the credit hint to non-402 errors', () => {
    const err = makeApiResponseError(403, { title: 'Forbidden', detail: 'no permission' });
    const msg = describeXApiError(err);
    expect(msg).not.toMatch(/AgentWeb's X \(Twitter\) API plan/);
    expect(msg).not.toMatch(/contact AgentWeb support/i);
  });
});

/**
 * ENG-664 — X 402 (credit exhaustion) must be a typed, machine-detectable
 * condition, not just prose inside a message. A depleted shared X wallet
 * (ENG-604/633/662) is a hard, non-retryable, platform-side stop.
 */
describe('isXApiCreditsError', () => {
  const xError = (code: number) => Object.assign(new Error(`Request failed with code ${code}`), { code });

  it('is true only for an X 402', () => {
    expect(isXApiCreditsError(xError(402))).toBe(true);
    expect(isXApiCreditsError(xError(403))).toBe(false);
    expect(isXApiCreditsError(xError(429))).toBe(false);
  });

  it('detects a wrapped XCreditsExhaustedError', () => {
    expect(isXApiCreditsError(new XCreditsExhaustedError('X API error (HTTP 402): ...'))).toBe(true);
  });

  it('is false for non-X errors and non-objects', () => {
    expect(isXApiCreditsError(new Error('boom'))).toBe(false);
    expect(isXApiCreditsError(undefined)).toBe(false);
    expect(isXApiCreditsError('402')).toBe(false);
  });
});

describe('XCreditsExhaustedError', () => {
  it('carries a stable name and HTTP 402 code so it classifies structurally', () => {
    const e = new XCreditsExhaustedError('out of credits');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('XCreditsExhaustedError');
    expect(e.code).toBe(402);
    expect(e.message).toBe('out of credits');
  });
});
