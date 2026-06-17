import { recordLeadCaptureFailure } from '../services/leadCaptureFailureService';
import { postSlackMessage } from '../services/slackService';

jest.mock('../services/slackService', () => ({
  postSlackMessage: jest.fn(),
}));

describe('recordLeadCaptureFailure', () => {
  const ORIGINAL_ENV = process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (ORIGINAL_ENV === undefined) {
      delete process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL;
    } else {
      process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL = ORIGINAL_ENV;
    }
  });

  it('always emits a structured log with the lead_capture_failure marker', async () => {
    await recordLeadCaptureFailure({
      reason: 'list_not_found',
      listId: 'list_dead',
      status: 404,
      source: 'demystifying_ai_lead_magnet',
      email: 'lead@acme.com',
    });

    expect(errorSpy).toHaveBeenCalledWith('[lead-capture-failure]', expect.stringContaining('lead_capture_failure'));
    const payload = JSON.parse((errorSpy.mock.calls[0][1]) as string);
    expect(payload).toMatchObject({
      reason: 'list_not_found',
      status: 404,
      listId: 'list_dead',
      source: 'demystifying_ai_lead_magnet',
      emailDomain: 'acme.com',
    });
  });

  it('logs only the email domain, never the full address (PII minimization)', async () => {
    await recordLeadCaptureFailure({ reason: 'list_not_found', listId: 'l', status: 404, email: 'jane.doe@example.com' });
    const logged = (errorSpy.mock.calls[0][1]) as string;
    expect(logged).toContain('example.com');
    expect(logged).not.toContain('jane.doe@example.com');
  });

  it('does NOT post to Slack when no alert channel is configured (default-off)', async () => {
    await recordLeadCaptureFailure({ reason: 'public_access_disabled', listId: 'list_x', status: 403 });
    expect(postSlackMessage).not.toHaveBeenCalled();
  });

  it('posts to Slack when an alert channel is configured', async () => {
    process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL = '#ops-alerts';
    (postSlackMessage as jest.Mock).mockResolvedValue({ ts: '1', channel: '#ops-alerts' });

    await recordLeadCaptureFailure({
      reason: 'public_access_disabled',
      listId: 'list_x',
      status: 403,
      source: 'ai-readiness-roadmap',
      userId: 'user_123',
    });

    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = (postSlackMessage as jest.Mock).mock.calls[0];
    expect(channel).toBe('#ops-alerts');
    expect(text).toContain('list_x');
    expect(text).toContain('ai-readiness-roadmap');
    expect(text).toContain('user_123');
  });

  it('never throws when the Slack post fails', async () => {
    process.env.LEAD_CAPTURE_ALERT_SLACK_CHANNEL = '#ops-alerts';
    (postSlackMessage as jest.Mock).mockRejectedValue(new Error('slack down'));

    await expect(
      recordLeadCaptureFailure({ reason: 'list_not_found', listId: 'list_x', status: 404 })
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith('[lead-capture-failure] slack post failed:', expect.any(Error));
  });
});
