import { classifyResendSendError, type ResendSendErrorInput } from '../dripResendSendError';

describe('classifyResendSendError (ENG-2566)', () => {
  it('retries 429 rate limits', () => {
    expect(classifyResendSendError({ statusCode: 429, name: 'rate_limit_exceeded' })).toEqual({
      action: 'retry',
      reason: 'rate_limited',
      retryable: true,
    });
    expect(classifyResendSendError({ name: 'rate_limit_exceeded' }).action).toBe('retry');
  });

  it('pauses the sequence on daily quota exhaustion (not retryable this window)', () => {
    expect(classifyResendSendError({ statusCode: 429, name: 'daily_quota_exceeded' })).toEqual({
      action: 'pause_sequence',
      reason: 'quota_exhausted',
      retryable: false,
    });
  });

  it('retries 5xx and network failures with no status', () => {
    expect(classifyResendSendError({ statusCode: 500, name: 'internal_server_error' })).toEqual({
      action: 'retry',
      reason: 'provider_unavailable',
      retryable: true,
    });
    expect(classifyResendSendError({ statusCode: 503 }).action).toBe('retry');
    expect(classifyResendSendError({ message: 'fetch failed: ECONNRESET' })).toEqual({
      action: 'retry',
      reason: 'provider_unavailable',
      retryable: true,
    });
  });

  it.each([
    [{ statusCode: 401, name: 'missing_api_key' }, 'auth_invalid'],
    [{ statusCode: 403, name: 'invalid_api_key' }, 'auth_invalid'],
    [{ statusCode: 401, name: 'restricted_api_key' }, 'auth_invalid'],
    [{ statusCode: 403 }, 'auth_invalid'],
    [{ name: 'invalid_api_key' }, 'auth_invalid'],
    [{ statusCode: 422, name: 'invalid_from_address' }, 'sender_misconfigured'],
    [
      { statusCode: 403, name: 'validation_error', message: 'The usehaven.ai domain is not verified.' },
      'domain_not_verified',
    ],
  ])('pauses the sequence on broken customer config %j', (input, reason) => {
    expect(classifyResendSendError(input)).toEqual({ action: 'pause_sequence', reason, retryable: false });
  });

  it('skips only the recipient on a recipient validation error', () => {
    expect(
      classifyResendSendError({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' }),
    ).toEqual({ action: 'skip_recipient', reason: 'invalid_recipient', retryable: false });
    expect(
      classifyResendSendError({ statusCode: 422, name: 'validation_error', message: 'Invalid email address: foo@' })
        .action,
    ).toBe('skip_recipient');
  });

  it('pauses on other 422 validation errors (step content is broken for everyone)', () => {
    expect(
      classifyResendSendError({ statusCode: 422, name: 'validation_error', message: 'Missing `subject` field.' }),
    ).toEqual({ action: 'pause_sequence', reason: 'invalid_message', retryable: false });
  });

  it('retries unknown shapes with reason unknown', () => {
    expect(classifyResendSendError({})).toEqual({ action: 'retry', reason: 'unknown', retryable: true });
    expect(classifyResendSendError({ statusCode: 418, name: 'teapot' })).toEqual({
      action: 'retry',
      reason: 'unknown',
      retryable: true,
    });
  });

  it('tolerates null/garbage input without throwing', () => {
    expect(classifyResendSendError(null as unknown as ResendSendErrorInput).reason).toBe('unknown');
    expect(classifyResendSendError({ statusCode: Number.NaN }).reason).toBe('unknown');
  });
});
