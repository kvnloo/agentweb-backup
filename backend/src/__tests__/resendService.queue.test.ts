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

describe('ResendService - queue and retry behavior', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetSecret.mockResolvedValue('test-resend-api-key');
  });

  it('queues concurrent sends and processes them one-by-one', async () => {
    let activeSends = 0;
    let maxConcurrentSends = 0;
    const sendOrder: string[] = [];

    mockResendSend.mockImplementation(async (emailOptions: any) => {
      activeSends += 1;
      maxConcurrentSends = Math.max(maxConcurrentSends, activeSends);
      sendOrder.push(emailOptions.subject);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeSends -= 1;
      return { data: { id: emailOptions.subject }, error: null };
    });

    const { resendService } = await import('../services/resendService');
    (resendService as any).MIN_SEND_INTERVAL_MS = 0;

    const results = await Promise.all([
      resendService.sendEmail({
        from: 'sender@example.com',
        to: 'one@example.com',
        subject: 'email-1',
        html: '<p>One</p>',
      }),
      resendService.sendEmail({
        from: 'sender@example.com',
        to: 'two@example.com',
        subject: 'email-2',
        html: '<p>Two</p>',
      }),
      resendService.sendEmail({
        from: 'sender@example.com',
        to: 'three@example.com',
        subject: 'email-3',
        html: '<p>Three</p>',
      }),
    ]);

    expect(mockResendSend).toHaveBeenCalledTimes(3);
    expect(maxConcurrentSends).toBe(1);
    expect(sendOrder).toEqual(['email-1', 'email-2', 'email-3']);
    expect(results.map((result) => result?.id)).toEqual(['email-1', 'email-2', 'email-3']);
  });

  it('retries retryable Resend failures with backoff and succeeds', async () => {
    mockResendSend
      .mockResolvedValueOnce({
        data: null,
        error: { statusCode: 500, message: 'temporary resend error' },
      })
      .mockResolvedValueOnce({
        data: { id: 'recovered-email-id' },
        error: null,
      });

    const { resendService } = await import('../services/resendService');
    (resendService as any).MIN_SEND_INTERVAL_MS = 0;
    (resendService as any).BASE_DELAY = 1;

    const result = await resendService.sendEmail({
      from: 'sender@example.com',
      to: 'retry@example.com',
      subject: 'retry-test',
      html: '<p>Retry test</p>',
    });

    expect(mockResendSend).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 'recovered-email-id' });
  });
});
