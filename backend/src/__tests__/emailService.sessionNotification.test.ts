import { emailService } from '../services/emailService';
import { settingsService } from '../services/settingsService';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createOrReuseInteractiveShare: jest.fn().mockResolvedValue('https://app.agentweb.pro/share/abc123'),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    claimSetMember: jest.fn(),
    releaseSetMember: jest.fn(),
  },
}));

describe('emailService.sendSessionNotificationEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: every claim wins (fresh session/recipient pair), matching the prior
    // no-dedup behavior for tests that aren't exercising ENG-1297 directly.
    (settingsService.claimSetMember as jest.Mock).mockResolvedValue(true);
  });

  it('sends via sendEmailStrict (system SMTP sender, throws on failure)', async () => {
    const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail(
      ['recipient@example.com'],
      'session-123',
      'Here is your report.'
    );

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('delivers to all specified recipients', async () => {
    const recipients = ['a@example.com', 'b@example.com'];
    const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail(recipients, 'session-456', 'Report');

    expect(spy).toHaveBeenCalledWith(recipients, expect.any(String), expect.any(String), expect.any(String));
  });

  it('accepts a single email string and delivers it', async () => {
    const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail('solo@example.com', 'session-789', 'Report');

    expect(spy).toHaveBeenCalledWith(['solo@example.com'], expect.any(String), expect.any(String), expect.any(String));
  });

  it('uses custom subject suffix when provided', async () => {
    const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail(
      ['r@example.com'],
      'session-111',
      'Report body',
      'Q1 Analysis'
    );

    expect(spy.mock.calls[0][1]).toContain('Q1 Analysis');
  });

  it('uses default subject when no subject provided', async () => {
    const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-222', 'Report body');

    expect(spy.mock.calls[0][1]).toContain('Session Report');
  });

  it('includes session link in email body', async () => {
    const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-333', 'Report body');

    const html = spy.mock.calls[0][3];
    expect(html).toContain('https://app.agentweb.pro/share/abc123');
  });

  it('throws when sendEmailStrict fails, so notify_session tool can surface the error', async () => {
    jest.spyOn(emailService, 'sendEmailStrict').mockRejectedValue(new Error('SMTP error'));

    await expect(
      emailService.sendSessionNotificationEmail(['r@example.com'], 'session-444', 'Report')
    ).rejects.toThrow('SMTP error');
  });

  it('does not swallow errors silently (sendEmail soft-fail path is not used)', async () => {
    const softSpy = jest.spyOn(emailService, 'sendEmail');
    jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

    await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-555', 'Report body');

    expect(softSpy).not.toHaveBeenCalled();
  });

  // ENG-1297: a post-completion scheduler nudge (or any other caller) resending a
  // notification for a session that already sent it must not produce a second email.
  describe('duplicate-send guard (ENG-1297)', () => {
    it('claims an idempotency key scoped to the session, recipients, and content before sending', async () => {
      jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

      await emailService.sendSessionNotificationEmail(['B@Example.com', 'a@example.com'], 'session-666', 'Report');

      expect(settingsService.claimSetMember).toHaveBeenCalledWith(
        'notify-session:session-666',
        expect.stringContaining(JSON.stringify(['a@example.com', 'b@example.com']))
      );
    });

    it('builds a collision-safe recipient signature (JSON, not a bare comma-join)', async () => {
      // A single recipient string containing an embedded comma must NOT normalize to
      // the same signature as the equivalent two-recipient array — a bare
      // `.join(',')` would collide these two calls and wrongly suppress the second.
      jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

      await emailService.sendSessionNotificationEmail(['a@x.com,b@x.com'], 'session-json-1', 'Report');
      await emailService.sendSessionNotificationEmail(['a@x.com', 'b@x.com'], 'session-json-2', 'Report');

      const [, embeddedCommaMember] = (settingsService.claimSetMember as jest.Mock).mock.calls[0];
      const [, splitRecipientsMember] = (settingsService.claimSetMember as jest.Mock).mock.calls[1];
      expect(embeddedCommaMember).not.toBe(splitRecipientsMember);
    });

    it('claims independently for different content, so a legitimate second notification is not permanently suppressed', async () => {
      jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

      await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-content-1', 'First report body');
      await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-content-2', 'Second, different report body');

      const [, firstMember] = (settingsService.claimSetMember as jest.Mock).mock.calls[0];
      const [, secondMember] = (settingsService.claimSetMember as jest.Mock).mock.calls[1];
      expect(firstMember).not.toBe(secondMember);
    });

    it('skips sending and returns duplicate:true when the claim is already held', async () => {
      (settingsService.claimSetMember as jest.Mock).mockResolvedValue(false);
      const spy = jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

      const result = await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-777', 'Report');

      expect(spy).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: false, duplicate: true });
    });

    it('returns sent:true after a fresh send', async () => {
      jest.spyOn(emailService, 'sendEmailStrict').mockResolvedValue({ messageId: 'msg-1' });

      const result = await emailService.sendSessionNotificationEmail(['r@example.com'], 'session-888', 'Report');

      expect(result).toEqual({ sent: true, duplicate: false });
    });

    it('releases the same claim member when the send fails, so a genuine retry can still succeed', async () => {
      jest.spyOn(emailService, 'sendEmailStrict').mockRejectedValue(new Error('SMTP error'));

      await expect(
        emailService.sendSessionNotificationEmail(['r@example.com'], 'session-999', 'Report')
      ).rejects.toThrow('SMTP error');

      const [, claimedMember] = (settingsService.claimSetMember as jest.Mock).mock.calls[0];
      expect(settingsService.releaseSetMember).toHaveBeenCalledWith('notify-session:session-999', claimedMember);
    });
  });
});
