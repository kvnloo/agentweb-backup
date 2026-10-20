/**
 * ENG-2551 (slice of ENG-2501): ScheduledPostPublisher adapter that publishes a
 * due scheduled post through the same code path the `post_on_connected_account`
 * tool uses today (`emma/impl/linkedin.ts#postOnConnectedAccount`).
 *
 * Unused until the parent's storage/scheduler wiring lands (Requires: Me).
 * No persistence here: the post's owner/account/platform come from an injected
 * resolver because ScheduledPostRecord's persisted shape is not decided yet.
 *
 * Idempotency: the key is forwarded on the tool context. The connected-account
 * path does not dedupe on it yet, so the wiring slice must still guarantee
 * at-most-once dispatch per key (see dispatchDuePosts publication contract).
 */
import type { PublishResult, ScheduledPostPublisher } from './dispatchDuePosts';
import type { ScheduledPostRecord } from './scheduledPostLifecycle';

export const SCHEDULED_POST_PLATFORMS = ['twitter', 'instagram', 'linkedin'] as const;
export type ScheduledPostPlatform = (typeof SCHEDULED_POST_PLATFORMS)[number];

export interface ScheduledPostTarget {
  userId: string;
  accountId?: string;
  platform: string;
}

export interface ConnectedAccountPostResult {
  success: boolean;
  message?: string;
  code?: number | string;
}

export type ConnectedAccountPostFn = (
  userId: string,
  accountId: string | undefined,
  content: string,
  mediaUrls: string[],
  platform: string,
  toolContext: { idempotencyKey: string; source: 'scheduled_post' },
) => Promise<ConnectedAccountPostResult>;

const PLATFORM_ALIASES: Record<string, ScheduledPostPlatform> = {
  twitter: 'twitter',
  x: 'twitter',
  instagram: 'instagram',
  linkedin: 'linkedin',
};

const NON_RETRYABLE = [
  /no longer connected/i,
  /not found or access denied/i,
  /token expired|reconnect|unauthori[sz]ed|forbidden|invalid[_ ]?token|auth/i,
  /policy|violat|duplicate content|not allowed|permission/i,
  /invalid|too long|exceeds|unsupported|validation|only supported/i,
  /multiple .* accounts connected/i,
];
const RETRYABLE = [/rate.?limit|too many requests|429/i, /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|socket hang up/i, /\b5\d\d\b|server error|service unavailable|bad gateway/i];

/** Classify a failed publish. Unknown failures are retryable (bounded by MAX_ATTEMPTS). */
export function classifyPublishFailure(message: string, code?: number | string): boolean {
  const status = typeof code === 'number' ? code : Number(code);
  if (Number.isFinite(status)) {
    if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true;
    if (status >= 400 && status < 500) return false;
  }
  if (RETRYABLE.some((r) => r.test(message))) return true;
  if (NON_RETRYABLE.some((r) => r.test(message))) return false;
  return true;
}

export function createConnectedAccountPublisher(deps: {
  resolveTarget: (record: ScheduledPostRecord) => Promise<ScheduledPostTarget | undefined>;
  post?: ConnectedAccountPostFn;
}): ScheduledPostPublisher {
  const post: ConnectedAccountPostFn =
    deps.post ??
    (async (...args) => {
      const { postOnConnectedAccount } = await import('../../emma/impl/linkedin');
      return postOnConnectedAccount(...args);
    });

  return {
    async publish(record, { idempotencyKey }): Promise<PublishResult> {
      const target = await deps.resolveTarget(record);
      if (!target) return { ok: false, error: `No publish target for scheduled post ${record.id}`, retryable: false };
      const platform = PLATFORM_ALIASES[String(target.platform).toLowerCase()];
      if (!platform) {
        return { ok: false, error: `Unsupported platform for scheduled posts: ${target.platform}`, retryable: false };
      }
      try {
        const res = await post(target.userId, target.accountId, record.content, record.mediaUrls ?? [], platform, {
          idempotencyKey,
          source: 'scheduled_post',
        });
        if (res?.success) return { ok: true };
        const error = res?.message || 'Publish failed';
        return { ok: false, error, retryable: classifyPublishFailure(error, res?.code) };
      } catch (err) {
        const e = err as { message?: string; code?: number | string };
        const error = e?.message ?? String(err);
        return { ok: false, error, retryable: classifyPublishFailure(error, e?.code) };
      }
    },
  };
}
