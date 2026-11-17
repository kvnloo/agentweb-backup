/**
 * ENG-2991: the real emailService.sendSubscriberConfirmationEmail (the route tests replace it with a mock). It goes to an address the task
 * owner does not control, from the owner's own sender, so what it puts in the subject and body, and whether it reports failure, matter.
 */
jest.mock('../services/db', () => ({
  taskDb: { getTaskById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));

import { emailService } from '../services/emailService';
import { taskDb, userDb } from '../services/db';
import { resendService } from '../services/resendService';

const send = resendService.sendEmail as jest.Mock;
const URL_ = 'https://api.example.test/api/tasks/t1/subscribers/confirm?token=abc.def.ghi';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: 'Weekly Report' });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner' });
  send.mockResolvedValue({ id: 'msg_1' });
});
afterEach(() => jest.restoreAllMocks());

describe('sendSubscriberConfirmationEmail', () => {
  it('sends the confirm link to the address and reports that it sent', async () => {
    const sent = await emailService.sendSubscriberConfirmationEmail('reader@example.com', 't1', URL_);
    expect(sent).toBe(true);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe('reader@example.com');
    // from the system address (this task has no sender of its own) the subject is fixed
    expect(mail.subject).toBe('Please confirm your subscription');
    expect(mail.html).toContain(`href="${URL_}"`);
    expect(mail.text).toContain(URL_);
    // the task name is not part of a mail that goes out from the system address
    expect(mail.html).not.toContain('Weekly Report');
    expect(mail.text).not.toContain('Weekly Report');
  });

  it('names the task in the mail only when it goes out from the owner\'s own sender', async () => {
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: 'Weekly Report', emailSender: 'news@brand.test', fromName: 'Brand News' });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    const mail = send.mock.calls[0][0];
    expect(mail.html).toContain('<strong>Weekly Report</strong>');
    expect(mail.text).toContain('updates for Weekly Report at this address');
  });

  it('falls back to the plain system confirmation when the owner\'s own sender is refused, so the sign-up is not lost (and it names no task)', async () => {
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: 'Weekly Report', emailSender: 'news@brand.test', fromName: 'Brand News' });
    send.mockRejectedValueOnce(Object.assign(new Error('The brand.test domain is not verified'), { statusCode: 403 })).mockResolvedValueOnce({ id: 'msg_2' });
    const sent = await emailService.sendSubscriberConfirmationEmail('reader@example.com', 't1', URL_);
    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].from).toBe('Brand News <news@brand.test>');
    const fallback = send.mock.calls[1][0];
    expect(fallback.from).not.toContain('brand.test');
    expect(fallback.replyTo).toBeTruthy();
    expect(fallback.subject).toBe('Please confirm your subscription');
    for (const part of [fallback.html, fallback.text]) {
      expect(part).not.toContain('Weekly Report');
      expect(part).toContain('Someone asked to receive email updates');
      expect(part).toContain(' at this address');
    }
    expect(fallback.text).toContain(URL_);
    // only a status code is logged (an error from the mail service can carry the recipient)
    const logged = (console.error as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('403');
    expect(logged).not.toContain('reader@example.com');
  });

  it.each([
    ['a name that contains the words the text is built around', 'x at this address WIRE MONEY'],
    ['regex characters and replacement patterns', '$& $1 (.*) \\ ^$'],
    ['markup', '</strong><img src=x onerror=alert(1)>'],
    ['line breaks', 'line one\nline two at this address\r\nline three'],
  ])('the fallback names no task in either part, for %s', async (_what, name) => {
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name, emailSender: 'news@brand.test', fromName: 'Brand News' });
    send.mockRejectedValueOnce(Object.assign(new Error('refused'), { statusCode: 403 })).mockResolvedValueOnce({ id: 'msg_3' });
    expect(await emailService.sendSubscriberConfirmationEmail('reader@example.com', 't1', URL_)).toBe(true);
    const fallback = send.mock.calls[1][0];
    for (const part of [fallback.html, fallback.text, fallback.subject]) {
      expect(part).not.toContain('WIRE MONEY');
      expect(part).not.toContain('onerror');
      expect(part).not.toContain('line two');
      expect(part).not.toContain('(.*)');
    }
    expect(fallback.text).toContain('Someone asked to receive email updates at this address.');
    // the mail from the owner's own sender still carries the name (escaped in the html)
    expect(send.mock.calls[0][0].text).toContain('updates for ');
  });

  it('reports failure (false) when the system address fails too, logging no address', async () => {
    send.mockRejectedValue(Object.assign(new Error('boom for reader@example.com'), { statusCode: 500 }));
    await expect(emailService.sendSubscriberConfirmationEmail('reader@example.com', 't1', URL_)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1); // there is no further fallback from the system address
    expect((console.error as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('reader@example.com');
  });

  it('does not write the address a stranger typed into the public form to the log', async () => {
    const log = console.log as jest.Mock;
    await emailService.sendSubscriberConfirmationEmail('stranger.typed@example.com', 't1', URL_);
    expect(log.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('stranger.typed');
  });

  it('sends from the task\'s own sender when it has one, otherwise from the owner\'s default sender, otherwise from the system address', async () => {
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: 'N', emailSender: 'news@brand.test', fromName: 'Brand News' });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    expect(send.mock.calls[0][0].from).toBe('Brand News <news@brand.test>');
    expect(send.mock.calls[0][0].replyTo).toBeUndefined();

    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: 'N' });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner', emailDomain: 'brand.test', defaultSenderUsername: 'hello', fromName: 'Brand' });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    expect(send.mock.calls[1][0].from).toBe('Brand <hello@brand.test>');

    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'owner' });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    expect(send.mock.calls[2][0].from).not.toContain('brand.test');
    expect(send.mock.calls[2][0].replyTo).toBeTruthy();
  });

  it('escapes the task name in the HTML body', async () => {
    // the name is shown only from the owner's own sender
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: '<img src=x onerror=alert(1)>', emailSender: 'news@brand.test', fromName: 'Brand News' });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    const html = send.mock.calls[0][0].html;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('puts the task name in the subject only when the mail goes out from the owner\'s own sender, on one short line', async () => {
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: `Win a prize\r\nBcc: someone@example.com ${'x'.repeat(500)}`, emailSender: 'news@brand.test', fromName: 'Brand News' });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    const subject: string = send.mock.calls[0][0].subject;
    expect(subject).toMatch(/^Confirm your subscription to Win a prize/);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.length).toBeLessThanOrEqual('Confirm your subscription to '.length + 80);
  });

  it('never sends an owner-written task name from the system address in the subject, and bounds it in the body', async () => {
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: `Claim your reward now ${'y'.repeat(500)}` });
    await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_);
    const mail = send.mock.calls[0][0];
    expect(mail.subject).toBe('Please confirm your subscription');
    expect(mail.subject).not.toContain('reward');
    expect(mail.html).not.toContain('reward');
    expect(mail.text).not.toContain('reward');
  });

  it('reports failure (so the caller can give the person their slot back) when sending fails, the task is gone or the owner is gone', async () => {
    send.mockRejectedValueOnce(new Error('Resend API error'));
    expect(await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_)).toBe(false);
    (taskDb.getTaskById as jest.Mock).mockResolvedValue(undefined);
    expect(await emailService.sendSubscriberConfirmationEmail('r@example.com', 'gone', URL_)).toBe(false);
    (taskDb.getTaskById as jest.Mock).mockResolvedValue({ taskId: 't1', userId: 'owner', name: 'N' });
    (userDb.getUserById as jest.Mock).mockResolvedValue(undefined);
    expect(await emailService.sendSubscriberConfirmationEmail('r@example.com', 't1', URL_)).toBe(false);
  });
});
