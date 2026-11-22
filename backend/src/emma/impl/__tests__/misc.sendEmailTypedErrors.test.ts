/**
 * ENG-2064: send_email_from_sender failed 3/3 observed calls classified as the
 * generic `Error` bucket. Every structured failure must carry a typed `reason`
 * and an HTTP-range `code`, so toolResultError -> classifyToolErrorClass lands
 * in a semantic class instead of the legacy-name fallback. Providers are mocked:
 * no email is sent.
 */

const mockResolveSenderForSend = jest.fn();
const mockSendAsSender = jest.fn();
class MockSenderDailyLimitExceededError extends Error {}

jest.mock('../../../services/crmSenderService', () => ({
  resolveSenderForSend: (...a: any[]) => mockResolveSenderForSend(...a),
}));
jest.mock('../../../services/sendAsSender', () => ({
  sendAsSender: (...a: any[]) => mockSendAsSender(...a),
  SenderDailyLimitExceededError: MockSenderDailyLimitExceededError,
}));
jest.mock('../../../services/emailProviderService', () => ({
  emailProviderErrorStatus: (e: any) => e?.providerStatus,
}));

import { sendEmailFromConfiguredSender } from '../misc';
import { toolResultError } from '../../../utils/toolResultError';
import { classifyToolErrorClass } from '../../../utils/toolErrorClassifier';

const resendSender = { id: 's1', email: 'ops@example.test', fromName: 'Ops', senderProvider: 'resend' };
const gmailSender = { id: 's2', email: 'me@example.test', fromName: 'Me', senderProvider: 'gmail', connectedAccountId: 'ca1' };
const senders = (list: any[]) => jest.fn().mockResolvedValue({ success: true, senders: list, defaultSenderId: list[0]?.id });
const valid = { to: 'lead@example.test', subject: 'Hi', text: 'Body' };

const classOf = (result: any) => {
  const err = toolResultError(result);
  expect(err).not.toBeNull();
  return classifyToolErrorClass(err);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveSenderForSend.mockImplementation(async (_u: string, id: string, email: string) => ({ id, email }));
});

describe('sendEmailFromConfiguredSender typed failures (ENG-2064)', () => {
  it('provider throws a plain Error -> provider_unavailable, upstream_5xx (not generic Error)', async () => {
    mockSendAsSender.mockRejectedValue(new Error('Something broke'));
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([resendSender]));
    expect(r).toMatchObject({ success: false, reason: 'provider_unavailable', code: 502 });
    expect(classOf(r)).toBe('upstream_5xx');
  });

  it('provider rejects with a 4xx status -> provider_rejected keeps the status', async () => {
    mockSendAsSender.mockRejectedValue(Object.assign(new Error('domain not verified'), { statusCode: 403 }));
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([resendSender]));
    expect(r).toMatchObject({ success: false, reason: 'provider_rejected', code: 403 });
    expect(classOf(r)).toBe('auth');
  });

  it('mailbox token failure -> needs_reconnect classified auth', async () => {
    mockSendAsSender.mockRejectedValue(new Error('invalid_grant'));
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([gmailSender]));
    expect(r).toMatchObject({ success: false, reason: 'needs_reconnect', code: 401 });
    expect(classOf(r)).toBe('auth');
  });

  it('daily cap -> daily_limit classified rate_limit', async () => {
    mockSendAsSender.mockRejectedValue(new MockSenderDailyLimitExceededError('cap reached'));
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([resendSender]));
    expect(r).toMatchObject({ success: false, reason: 'daily_limit' });
    expect(classOf(r)).toBe('rate_limit');
  });

  it('no senders -> no_sender classified not_found, nothing sent', async () => {
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([]));
    expect(r).toMatchObject({ success: false, reason: 'no_sender' });
    expect(classOf(r)).toBe('not_found');
    expect(mockSendAsSender).not.toHaveBeenCalled();
  });

  it('unknown sender_id -> sender_not_found classified not_found', async () => {
    const r = await sendEmailFromConfiguredSender('u1', { ...valid, senderId: 'nobody@x.test' }, senders([resendSender]));
    expect(r).toMatchObject({ success: false, reason: 'sender_not_found' });
    expect(classOf(r)).toBe('not_found');
  });

  it('bad recipient / missing body -> invalid_args', async () => {
    const bad = await sendEmailFromConfiguredSender('u1', { ...valid, to: 'not-an-email' }, senders([resendSender]));
    expect(bad).toMatchObject({ reason: 'invalid_recipient' });
    expect(classOf(bad)).toBe('invalid_args');
    const empty = await sendEmailFromConfiguredSender('u1', { ...valid, text: ' ' }, senders([resendSender]));
    expect(empty).toMatchObject({ reason: 'missing_field' });
    expect(classOf(empty)).toBe('invalid_args');
  });

  it('mailbox sender without connected account -> sender_misconfigured classified auth', async () => {
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([{ ...gmailSender, connectedAccountId: undefined }]));
    expect(r).toMatchObject({ reason: 'sender_misconfigured' });
    expect(classOf(r)).toBe('auth');
  });

  it('success path unchanged', async () => {
    mockSendAsSender.mockResolvedValue({ messageId: 'm1' });
    const r = await sendEmailFromConfiguredSender('u1', valid, senders([resendSender]));
    expect(r).toMatchObject({ success: true, emailId: 'm1', from: 'ops@example.test' });
  });
});
