/**
 * ENG-1215 — the guard must actually stop the send, not merely compute a verdict.
 *
 * nonProdEmailGuard.test.ts pins the pure decision logic. This pins the wiring:
 * a real customer address must never reach the Resend client from a non-prod
 * environment, and a production environment must be entirely unaffected.
 *
 * Jest runs with NODE_ENV=test, so the guard is active here by default — which
 * is the same posture staging and previews run in.
 */

// Makes this file a module. Without it TypeScript treats both this and
// resendService.queue.test.ts as scripts in one global scope, and the shared
// mock names collide (TS2451).
export {};

const mockGetSecret = jest.fn();
const mockResendSend = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
}));

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockResendSend },
  })),
}));

const ORIGINAL_ENV = { ...process.env };

describe('ENG-1215 — non-prod guard at the Resend chokepoint', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetSecret.mockResolvedValue('test-resend-api-key');
    mockResendSend.mockResolvedValue({ data: { id: 'real-provider-id' }, error: null });
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('never hands a real customer address to the provider', async () => {
    const { resendService } = await import('../services/resendService');

    const result = await resendService.sendEmail({
      from: 'AgentWeb <no-reply@agentweb.pro>',
      to: 'a.real.customer@acme.io',
      subject: 'Your weekly report',
      text: 'body',
    });

    expect(mockResendSend).not.toHaveBeenCalled();
    // Labelled, so an audit row cannot pass this off as a real delivery.
    expect((result as any).id).toBe('nonprod-suppressed');
    expect((result as any).suppressed).toBe(true);
  });

  it('strips a real address out of a mixed send but still delivers the allowlisted one', async () => {
    const { resendService } = await import('../services/resendService');

    await resendService.sendEmail({
      from: 'AgentWeb <no-reply@agentweb.pro>',
      to: ['test@example.com', 'a.real.customer@acme.io'],
      cc: ['leak@acme.io'],
      subject: 'Mixed',
      text: 'body',
    });

    expect(mockResendSend).toHaveBeenCalledTimes(1);
    const sent = mockResendSend.mock.calls[0][0];
    expect(sent.to).toEqual(['test@example.com']);
    expect(sent.cc).toBeUndefined();
  });

  it('delivers normally to an allowlisted recipient', async () => {
    const { resendService } = await import('../services/resendService');

    await resendService.sendEmail({
      from: 'AgentWeb <no-reply@agentweb.pro>',
      to: 'test@example.com',
      subject: 'Fixture',
      text: 'body',
    });

    expect(mockResendSend).toHaveBeenCalledTimes(1);
    // performSend normalizes a single recipient to an array before the call.
    expect(mockResendSend.mock.calls[0][0].to).toEqual(['test@example.com']);
  });

  it('is a NO-OP in production — real mail must go out untouched', async () => {
    process.env.NODE_ENV = 'production';
    const { resendService } = await import('../services/resendService');

    await resendService.sendEmail({
      from: 'AgentWeb <no-reply@agentweb.pro>',
      to: 'a.real.customer@acme.io',
      subject: 'Your weekly report',
      text: 'body',
    });

    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(mockResendSend.mock.calls[0][0].to).toEqual(['a.real.customer@acme.io']);
  });

  it('never lets sendEmailStrict report a suppressed send as delivered', async () => {
    // CodeRabbit caught this: the guard returns a string `id` so the
    // "no messageId" check does not misread it as a provider failure — but a
    // string id is exactly what every delivery-status consumer treats as proof
    // of delivery. Recording a blocked message as delivered is a worse failure
    // than the one the guard prevents.
    const { emailService } = await import('../services/emailService');

    await expect(
      emailService.sendEmailStrict('a.real.customer@acme.io', 'Audited', 'text', '<p>html</p>'),
    ).rejects.toThrow(/suppressed by the non-prod email guard/);

    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('still returns a real provider messageId for an allowlisted strict send', async () => {
    const { emailService } = await import('../services/emailService');

    const result = await emailService.sendEmailStrict(
      'test@example.com', 'Audited', 'text', '<p>html</p>',
    );

    expect(result.messageId).toBe('real-provider-id');
  });

  it('does not log a suppressed best-effort send as sent', async () => {
    const { emailService } = await import('../services/emailService');
    const logged: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      logged.push(args.join(' '));
    });

    await emailService.sendEmail('a.real.customer@acme.io', 'Best effort', 'text', '<p>html</p>');
    spy.mockRestore();

    expect(logged.some((line) => /Email sent successfully/.test(line))).toBe(false);
    expect(logged.some((line) => /suppressed by the non-prod guard/.test(line))).toBe(true);
  });

  it('honours an explicit allow-all for a deliberate staging delivery test', async () => {
    process.env.NONPROD_EMAIL_ALLOW_ALL = 'true';
    const { resendService } = await import('../services/resendService');

    await resendService.sendEmail({
      from: 'AgentWeb <no-reply@agentweb.pro>',
      to: 'qa-target@acme.io',
      subject: 'Deliberate',
      text: 'body',
    });

    expect(mockResendSend).toHaveBeenCalledTimes(1);
  });
});
