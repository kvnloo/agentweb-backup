import { classifyPublishFailure, createConnectedAccountPublisher } from '../connectedAccountPublisher';
import { scheduledPostIdempotencyKey } from '../dispatchDuePosts';
import type { ScheduledPostRecord } from '../scheduledPostLifecycle';

const record: ScheduledPostRecord = {
  id: 'sp-1',
  status: 'pending',
  publishAt: new Date('2026-10-20T10:00:00Z'),
  content: 'hello',
  mediaUrls: ['https://cdn/x.png'],
};
const key = scheduledPostIdempotencyKey(record.id);

function setup(platform: string, postImpl: any = jest.fn().mockResolvedValue({ success: true })) {
  const pub = createConnectedAccountPublisher({
    resolveTarget: async () => ({ userId: 'u1', accountId: 'acc1', platform }),
    post: postImpl,
  });
  return { pub, post: postImpl };
}

describe('connectedAccountPublisher (ENG-2551)', () => {
  it.each([['twitter', 'twitter'], ['x', 'twitter'], ['instagram', 'instagram'], ['linkedin', 'linkedin']])(
    'publishes %s with content, media, and idempotency key',
    async (platform, expected) => {
      const { pub, post } = setup(platform);
      await expect(pub.publish(record, { idempotencyKey: key })).resolves.toEqual({ ok: true });
      expect(post).toHaveBeenCalledWith('u1', 'acc1', 'hello', ['https://cdn/x.png'], expected, {
        idempotencyKey: 'scheduled-post:sp-1',
        source: 'scheduled_post',
      });
    },
  );

  it('unsupported platform is non-retryable with no network call', async () => {
    const { pub, post } = setup('youtube');
    const r = await pub.publish(record, { idempotencyKey: key });
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(post).not.toHaveBeenCalled();
  });

  it('missing target is non-retryable', async () => {
    const pub = createConnectedAccountPublisher({ resolveTarget: async () => undefined, post: jest.fn() });
    expect(await pub.publish(record, { idempotencyKey: key })).toMatchObject({ ok: false, retryable: false });
  });

  it.each([
    ['LinkedIn account is no longer connected', undefined],
    ['Account not found or access denied', undefined],
    ['Failed to post: Account token expired. Please reconnect the account in Settings.', undefined],
    ['Failed to post: content violates policy', undefined],
    ['Failed to post: Tweet too long', undefined],
    ['Failed to post: something', 401],
    ['Failed to post: something', 403],
  ])('non-retryable: %s (%s)', async (message, code) => {
    const { pub } = setup('linkedin', jest.fn().mockResolvedValue({ success: false, message, code }));
    expect(await pub.publish(record, { idempotencyKey: key })).toEqual({ ok: false, error: message, retryable: false });
  });

  it.each([
    ['Failed to post: Rate limit exceeded', undefined],
    ['Failed to post: request timed out', undefined],
    ['Failed to post: 503 Service Unavailable', undefined],
    ['Failed to post: x', 429],
    ['Failed to post: x', 502],
  ])('retryable: %s (%s)', async (message, code) => {
    const { pub } = setup('twitter', jest.fn().mockResolvedValue({ success: false, message, code }));
    expect(await pub.publish(record, { idempotencyKey: key })).toEqual({ ok: false, error: message, retryable: true });
  });

  it('thrown errors are classified, not propagated', async () => {
    const { pub } = setup('instagram', jest.fn().mockRejectedValue(Object.assign(new Error('ETIMEDOUT'), {})));
    expect(await pub.publish(record, { idempotencyKey: key })).toEqual({ ok: false, error: 'ETIMEDOUT', retryable: true });
  });

  it('status code takes precedence over message text', () => {
    expect(classifyPublishFailure('invalid gateway response', 502)).toBe(true);
    expect(classifyPublishFailure('timeout', 400)).toBe(false);
  });
});
