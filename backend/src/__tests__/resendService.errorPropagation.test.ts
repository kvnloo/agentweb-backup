/**
 * ENG-164 acceptance criterion 2 — Resend failures must SURFACE, not go dark.
 *
 * Contract under test: `resendService.sendEmail` REJECTS on failure. It never
 * resolves `null` for a failed send. Before this fix the service swallowed
 * every error (init failure, exhausted retries, non-retryable API errors) and
 * resolved `null`, so callers could not distinguish "sent" from "silently
 * dropped" — the exact hidden-fallback failure mode the migration off SMTP
 * is meant to eliminate.
 */

export {}; // make this file a module so its mock consts don't collide with resendService.queue.test.ts

const mockGetSecret = jest.fn();
const mockResendSend = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
}));

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: mockResendSend,
    },
  })),
}));

const baseParams = {
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'error-propagation-test',
  html: '<p>Test</p>',
};

async function importFreshService() {
  const { resendService } = await import('../services/resendService');
  (resendService as any).MIN_SEND_INTERVAL_MS = 0;
  (resendService as any).BASE_DELAY = 1;
  return resendService;
}

describe('ResendService - error propagation (ENG-164 AC-2)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetSecret.mockResolvedValue('test-resend-api-key');
  });

  it('rejects (does NOT resolve null) when the Resend API fails with 500 on every retry', async () => {
    mockResendSend.mockResolvedValue({
      data: null,
      error: { statusCode: 500, message: 'persistent resend outage' },
    });

    const resendService = await importFreshService();

    await expect(resendService.sendEmail(baseParams)).rejects.toThrow(/Resend API error/);
    // All retries were attempted before giving up loudly.
    expect(mockResendSend).toHaveBeenCalledTimes(3);
  });

  it('rejects immediately on a non-retryable 4xx error without burning retries', async () => {
    mockResendSend.mockResolvedValue({
      data: null,
      error: { statusCode: 422, message: 'invalid from address' },
    });

    const resendService = await importFreshService();

    await expect(resendService.sendEmail(baseParams)).rejects.toThrow(/Resend API error/);
    expect(mockResendSend).toHaveBeenCalledTimes(1);
  });

  it('rejects when the service cannot initialize (missing API key), not null', async () => {
    mockGetSecret.mockResolvedValue(null);

    const resendService = await importFreshService();

    await expect(resendService.sendEmail(baseParams)).rejects.toThrow(/not initialized/i);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('a failed send rejects its own promise but does not break the queue for later sends', async () => {
    mockResendSend
      .mockResolvedValueOnce({
        data: null,
        error: { statusCode: 403, message: 'domain not verified' },
      })
      .mockResolvedValueOnce({
        data: { id: 'second-email-id' },
        error: null,
      });

    const resendService = await importFreshService();

    const [first, second] = await Promise.allSettled([
      resendService.sendEmail({ ...baseParams, subject: 'fails' }),
      resendService.sendEmail({ ...baseParams, subject: 'succeeds' }),
    ]);

    expect(first.status).toBe('rejected');
    expect((first as PromiseRejectedResult).reason.message).toMatch(/Resend API error/);
    expect(second.status).toBe('fulfilled');
    expect((second as PromiseFulfilledResult<any>).value).toEqual({ id: 'second-email-id' });
  });

  it('still resolves with the Resend payload on success', async () => {
    mockResendSend.mockResolvedValue({
      data: { id: 'happy-path-id' },
      error: null,
    });

    const resendService = await importFreshService();

    await expect(resendService.sendEmail(baseParams)).resolves.toEqual({ id: 'happy-path-id' });
  });
});
