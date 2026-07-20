import { describeXApiError } from '../utils/twitterErrors';

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

  it('omits the HTTP-status prefix when code is not numeric', () => {
    const err = Object.assign(new Error('x'), { data: { title: 'Bad Request' } });
    const msg = describeXApiError(err);
    expect(msg).toContain('Bad Request');
    expect(msg).not.toContain('HTTP');
  });
});
