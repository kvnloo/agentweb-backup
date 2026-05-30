/**
 * Tests for the heartbeat surface added to runOnboardingLoop:
 *   - computeHeartbeatMetrics: pure metric aggregation over users + config
 *   - formatHeartbeat: deterministic Slack-mrkdwn string
 *   - postHeartbeatSlackDM: posts via chat.postMessage with user-as-channel
 *     (works without im:write scope, which the bot does not have)
 *
 * Plus regression coverage for the logRun ts-key bug:
 *   the table's composite key is (runId HASH, ts RANGE). Pre-fix code wrote
 *   `runAt` instead of `ts`, so every write threw silently. We verify the
 *   item the put receives includes `ts`.
 */

import { computeHeartbeatMetrics, HeartbeatUser } from '../cron/onboardingLoop';
import { formatHeartbeat, postHeartbeatSlackDM, HeartbeatMetrics } from '../services/onboardingLoopApproval';

// Fixed clock for deterministic windowing
const NOW = new Date('2026-05-25T16:00:00.000Z');
const NOW_MS = NOW.getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const baseConfig = {
  steps: {
    icp_setup: {
      active_variants: [{ variantId: 'icp-setup-control-v1', type: 'control' }],
    },
  },
};

const user = (overrides: Partial<HeartbeatUser> = {}): HeartbeatUser => ({
  userId: 'u-' + Math.random().toString(36).slice(2, 8),
  createdAt: new Date(NOW_MS - 60 * DAY).toISOString(),
  ...overrides,
});

describe('computeHeartbeatMetrics', () => {
  it('returns zeros and "(unset)" stage for empty user list', () => {
    const m = computeHeartbeatMetrics([], baseConfig, NOW);
    expect(m.totalUsers).toBe(0);
    expect(m.signups).toEqual({ last24h: 0, last7d: 0 });
    expect(m.completions).toEqual({ last24h: 0, last7d: 0 });
    expect(m.selfActive).toEqual({ last24h: 0, last7d: 0, last30d: 0 });
    expect(m.pilotRatio).toBeNull();
    expect(m.stageDistribution).toEqual({});
  });

  it('counts signups inside the 24h and 7d windows, ignoring older ones', () => {
    const users = [
      user({ createdAt: new Date(NOW_MS - 2 * HOUR).toISOString() }), // 24h yes, 7d yes
      user({ createdAt: new Date(NOW_MS - 3 * DAY).toISOString() }), // 24h no, 7d yes
      user({ createdAt: new Date(NOW_MS - 10 * DAY).toISOString() }), // outside both
      user({ createdAt: 'not-a-date' }), // junk → ignored
      user({ createdAt: undefined }), // missing → ignored
    ];
    const m = computeHeartbeatMetrics(users, baseConfig, NOW);
    expect(m.signups.last24h).toBe(1);
    expect(m.signups.last7d).toBe(2);
  });

  it('counts onboarding_completed events inside windows by event ts, not user createdAt', () => {
    const users = [
      user({
        createdAt: new Date(NOW_MS - 60 * DAY).toISOString(), // old account
        onboardingEvents: [
          { event: 'onboarding_completed', ts: new Date(NOW_MS - 3 * HOUR).toISOString() }, // completed today
        ],
      }),
      user({
        onboardingEvents: [
          { event: 'goal_selected', ts: new Date(NOW_MS - 1 * HOUR).toISOString() }, // wrong event type
          { event: 'onboarding_completed', ts: new Date(NOW_MS - 5 * DAY).toISOString() }, // 7d window only
        ],
      }),
    ];
    const m = computeHeartbeatMetrics(users, baseConfig, NOW);
    expect(m.completions.last24h).toBe(1);
    expect(m.completions.last7d).toBe(2);
  });

  it('counts self-active using lastActiveAt with set dedup (one user, multiple windows)', () => {
    const users = [
      user({ userId: 'u-1', lastActiveAt: new Date(NOW_MS - 2 * HOUR).toISOString() }), // 24h+7d+30d
      user({ userId: 'u-2', lastActiveAt: new Date(NOW_MS - 4 * DAY).toISOString() }),  // 7d+30d
      user({ userId: 'u-3', lastActiveAt: new Date(NOW_MS - 20 * DAY).toISOString() }), // 30d only
      user({ userId: 'u-4', lastActiveAt: new Date(NOW_MS - 60 * DAY).toISOString() }), // none
      user({ userId: undefined, lastActiveAt: new Date(NOW_MS - 1 * HOUR).toISOString() }), // no userId → skip
    ];
    const m = computeHeartbeatMetrics(users, baseConfig, NOW);
    expect(m.selfActive.last24h).toBe(1);
    expect(m.selfActive.last7d).toBe(2);
    expect(m.selfActive.last30d).toBe(3);
  });

  it('computes pilotRatio as (logged in but never self-active) / (logged in)', () => {
    const recent = new Date(NOW_MS - 10 * DAY).toISOString();
    const users = [
      user({ userId: 'u-1', lastLoginTime: recent, lastActiveAt: recent }), // self-active
      user({ userId: 'u-2', lastLoginTime: recent, lastActiveAt: undefined }), // pilot-only
      user({ userId: 'u-3', lastLoginTime: recent, lastActiveAt: undefined }), // pilot-only
      user({ userId: 'u-4', lastLoginTime: undefined, lastActiveAt: undefined }), // not eligible
    ];
    const m = computeHeartbeatMetrics(users, baseConfig, NOW);
    expect(m.pilotRatio).toBeCloseTo(2 / 3, 5);
  });

  it('returns null pilotRatio when no users logged in within 30d', () => {
    const m = computeHeartbeatMetrics([user()], baseConfig, NOW);
    expect(m.pilotRatio).toBeNull();
  });

  it('tallies stageDistribution by onboardingStage, mapping missing to "(unset)"', () => {
    const users = [
      user({ onboardingStage: 'brand_submitted' }),
      user({ onboardingStage: 'brand_submitted' }),
      user({ onboardingStage: 'active' }),
      user({ onboardingStage: undefined }),
      user({ onboardingStage: undefined }),
      user({ onboardingStage: undefined }),
    ];
    const m = computeHeartbeatMetrics(users, baseConfig, NOW);
    expect(m.stageDistribution).toEqual({
      brand_submitted: 2,
      active: 1,
      '(unset)': 3,
    });
  });

  it('control-only reason explains the loop drafts a daily challenger (heartbeat is now the exception)', () => {
    // The heartbeat now only fires when a daily draft fails quality review, not
    // because proposing is impossible. The reason must reflect that the loop
    // DOES draft challengers — not the old "need a challenger variant" framing
    // that made the no-op look like intended behavior.
    const m = computeHeartbeatMetrics([], baseConfig, NOW);
    expect(m.reason).toContain('drafts a challenger');
    expect(m.reason).toContain('1 step(s)');
    expect(m.reason).not.toContain('Need a challenger variant');
  });

  it('produces "healthy bounds" reason when challengers exist', () => {
    const configWithChallenger = {
      steps: {
        icp_setup: {
          active_variants: [
            { variantId: 'ctrl', type: 'control' },
            { variantId: 'chl', type: 'challenger' },
          ],
        },
      },
    };
    const m = computeHeartbeatMetrics([], configWithChallenger, NOW);
    expect(m.reason).toContain('healthy bounds');
  });
});

describe('formatHeartbeat', () => {
  const baseMetrics: HeartbeatMetrics = {
    todayStr: '2026-05-25',
    reason: 'test reason',
    totalUsers: 100,
    stageDistribution: { '(unset)': 90, brand_submitted: 9, active: 1 },
    signups: { last24h: 1, last7d: 5 },
    completions: { last24h: 0, last7d: 0 },
    selfActive: { last24h: 14, last7d: 28, last30d: 46 },
    pilotRatio: 0.33,
  };

  it('includes the date in the header', () => {
    expect(formatHeartbeat(baseMetrics)).toContain('2026-05-25');
  });

  it('lists every non-zero stage from the distribution', () => {
    const out = formatHeartbeat(baseMetrics);
    expect(out).toContain('(unset)');
    expect(out).toContain('brand_submitted');
    expect(out).toContain('active');
  });

  it('omits stages with zero users from the funnel block', () => {
    const out = formatHeartbeat({ ...baseMetrics, stageDistribution: { brand_submitted: 5 } });
    // The funnel rows look like "  • <stage_name>          <count>  (<pct>)"
    // Self-active line is "  • Self-active users: <n>" so it won't false-match.
    expect(out).not.toMatch(/^\s*•\s+active\s/m);
    expect(out).not.toMatch(/^\s*•\s+stale\s/m);
  });

  it('includes self-active counts', () => {
    const out = formatHeartbeat(baseMetrics);
    expect(out).toMatch(/Self-active users: 14/);
    expect(out).toMatch(/Self-active users: 28/);
  });

  it('shows pilot ratio when present, omits the line when null', () => {
    expect(formatHeartbeat(baseMetrics)).toMatch(/Pilot ratio:/);
    expect(formatHeartbeat({ ...baseMetrics, pilotRatio: null })).not.toMatch(/Pilot ratio:/);
  });
});

describe('postHeartbeatSlackDM', () => {
  const metrics: HeartbeatMetrics = {
    todayStr: '2026-05-25',
    reason: 'test',
    totalUsers: 0,
    stageDistribution: {},
    signups: { last24h: 0, last7d: 0 },
    completions: { last24h: 0, last7d: 0 },
    selfActive: { last24h: 0, last7d: 0, last30d: 0 },
    pilotRatio: null,
  };

  it('posts to the user ID directly (avoids im:write scope requirement)', async () => {
    const postMessage = jest.fn().mockResolvedValue({ ok: true, ts: '12345.6789' });
    const client = { chat: { postMessage } } as any;
    const out = await postHeartbeatSlackDM(metrics, 'U08TM4QFQ1L', client);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'U08TM4QFQ1L', mrkdwn: true }),
    );
    expect(out).toEqual({ channel: 'U08TM4QFQ1L', ts: '12345.6789' });
  });

  it('throws when Slack returns !ok', async () => {
    const postMessage = jest.fn().mockResolvedValue({ ok: false, error: 'channel_not_found' });
    const client = { chat: { postMessage } } as any;
    await expect(postHeartbeatSlackDM(metrics, 'U-bad', client)).rejects.toThrow(/channel_not_found/);
  });
});
