/**
 * ENG-2984: every Resend send carries a deterministic Idempotency-Key derived from
 * (tenant, recipient, content hash, intent); timeout retries reuse the same key.
 */
const mockGetSecret = jest.fn();
const mockResendSend = jest.fn();

jest.mock('../utils/secretsManager', () => ({
  getSecret: (...args: any[]) => mockGetSecret(...args),
}));

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockResendSend } })),
}));

const base = {
  from: 'sales@acme.com',
  to: 'lead@contractor.com',
  subject: 'Hello',
  html: '<p>hi</p>',
  tenantId: 'user-1',
  idempotencyIntent: 'drip:seq-1:step-2',
};

describe('ResendService — Idempotency-Key (ENG-2984)', () => {
  const prevAllowAll = process.env.NONPROD_EMAIL_ALLOW_ALL;
  beforeAll(() => { process.env.NONPROD_EMAIL_ALLOW_ALL = 'true'; });
  afterAll(() => { process.env.NONPROD_EMAIL_ALLOW_ALL = prevAllowAll; });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetSecret.mockResolvedValue('test-resend-api-key');
  });

  const load = async () => {
    const mod = await import('../services/resendService');
    (mod.resendService as any).MIN_SEND_INTERVAL_MS = 0;
    (mod.resendService as any).BASE_DELAY = 1;
    return mod;
  };

  it('reuses the identical key when a timeout is retried', async () => {
    mockResendSend
      .mockRejectedValueOnce(new Error('Request timed out'))
      .mockResolvedValueOnce({ data: { id: 'email-1' }, error: null });
    const { resendService } = await load();

    const result = await resendService.sendEmail(base);

    expect(result).toEqual({ id: 'email-1' });
    expect(mockResendSend).toHaveBeenCalledTimes(2);
    const k1 = mockResendSend.mock.calls[0][1]?.idempotencyKey;
    const k2 = mockResendSend.mock.calls[1][1]?.idempotencyKey;
    expect(typeof k1).toBe('string');
    expect(k1.length).toBeGreaterThan(0);
    expect(k2).toBe(k1);
  });

  it('is deterministic for the same tenant, recipient, content and intent', async () => {
    const { buildResendIdempotencyKey } = await load();
    expect(buildResendIdempotencyKey(base)).toBe(buildResendIdempotencyKey({ ...base }));
    // Recipient case/order does not split the key.
    expect(buildResendIdempotencyKey({ ...base, to: ['B@x.com', 'a@x.com'] }))
      .toBe(buildResendIdempotencyKey({ ...base, to: ['a@x.com', 'b@x.com'] }));
  });

  it('gives a different key for different content, recipient, tenant or intent', async () => {
    const { buildResendIdempotencyKey } = await load();
    const k = buildResendIdempotencyKey(base);
    expect(buildResendIdempotencyKey({ ...base, html: '<p>hi there</p>' })).not.toBe(k);
    expect(buildResendIdempotencyKey({ ...base, subject: 'Hello again' })).not.toBe(k);
    expect(buildResendIdempotencyKey({ ...base, to: 'other@contractor.com' })).not.toBe(k);
    expect(buildResendIdempotencyKey({ ...base, tenantId: 'user-2' })).not.toBe(k);
    expect(buildResendIdempotencyKey({ ...base, idempotencyIntent: 'drip:seq-1:step-3' })).not.toBe(k);
  });

  it('passes the derived key on the send, and different content gets a different key', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 'x' }, error: null });
    const { resendService, buildResendIdempotencyKey } = await load();

    await resendService.sendEmail(base);
    await resendService.sendEmail({ ...base, html: '<p>different</p>' });

    expect(mockResendSend.mock.calls[0][1]).toEqual({ idempotencyKey: buildResendIdempotencyKey(base) });
    expect(mockResendSend.mock.calls[1][1].idempotencyKey).not.toBe(mockResendSend.mock.calls[0][1].idempotencyKey);
  });

  it('without a caller intent, two separate identical sends are NOT merged (unchanged behaviour)', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 'x' }, error: null });
    const { resendService } = await load();
    const { idempotencyIntent, ...noIntent } = base;

    await resendService.sendEmail(noIntent);
    await resendService.sendEmail(noIntent);

    expect(mockResendSend).toHaveBeenCalledTimes(2);
    const [a, b] = mockResendSend.mock.calls.map((c) => c[1].idempotencyKey);
    expect(a).toEqual(expect.any(String));
    expect(b).not.toBe(a);
  });
});
