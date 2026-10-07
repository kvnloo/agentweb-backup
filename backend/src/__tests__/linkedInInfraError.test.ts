import { isLinkedInInfraError, LINKEDIN_UNAVAILABLE_MESSAGE } from '../utils/linkedInInfraError';

describe('isLinkedInInfraError (ENG-2205)', () => {
  it.each([
    ['credential fetch failure', new Error('Failed to fetch Unipile credentials from Secrets Manager')],
    ['gateway html body (the real outage shape)', new Error('<html><head><title>502 Bad Gateway</title></head></html>')],
    ['transport error', new Error('connect ECONNRESET 1.2.3.4:443')],
    ['SERVER_ERROR classification', Object.assign(new Error('x'), { structuredError: { classification: 'SERVER_ERROR' } })],
    ['TIMEOUT_ERROR classification', Object.assign(new Error('x'), { structuredError: { classification: 'TIMEOUT_ERROR' } })],
    ['isTimeout flag', Object.assign(new Error('x'), { isTimeout: true })],
    ['DNS failure (EAI_AGAIN)', new Error('getaddrinfo EAI_AGAIN api.unipile.com')],
    ['broken pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    ['undici terminated', new Error('terminated')],
    ['undici code on cause', Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } })],
    ['transport code on cause', Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })],
    ['AbortError', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })],
  ])('treats %s as infrastructure', (_l, err) => expect(isLinkedInInfraError(err)).toBe(true));

  it.each([
    ['business rejection', new Error('Cannot send message: target is not a 1st-degree connection')],
    ['rate limit', Object.assign(new Error('Unipile rate limited'), { structuredError: { classification: 'RATE_LIMIT_ERROR' } })],
    ['not found', Object.assign(new Error('Resource not found.'), { structuredError: { classification: 'NOT_FOUND' } })],
    ['auth error', Object.assign(new Error('Disconnected account'), { structuredError: { classification: 'AUTH_ERROR' } })],
    ['a message that merely contains "terminated"', new Error('Account terminated by LinkedIn')],
    ['numeric status code (not a transport code)', Object.assign(new Error('x'), { code: 404 })],
    ['undefined', undefined],
  ])('does NOT treat %s as infrastructure', (_l, err) => expect(isLinkedInInfraError(err)).toBe(false));

  it('exposes a message with no internal detail', () => {
    expect(LINKEDIN_UNAVAILABLE_MESSAGE).not.toMatch(/Unipile|Secrets|Gateway/i);
  });
});
