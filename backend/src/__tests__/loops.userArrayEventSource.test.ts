/**
 * Tests for UserArrayEventSource — reads per-user onboardingEvents[] into the
 * normalized event stream so the onboarding loop can run on the framework.
 */

import { UserArrayEventSource, type UserArrayRecord } from '../loops/core/sensors/userArrayEventSource';
import type { TimeWindow } from '../loops/core/types';

const WINDOW: TimeWindow = { start: new Date('2026-05-20T00:00:00Z'), end: new Date('2026-05-30T00:00:00Z') };

function users(): UserArrayRecord[] {
  return [
    {
      userId: 'u1',
      createdAt: '2026-05-25T00:00:00Z',
      onboardingEvents: [
        { event: 'goal_selected' },
        { event: 'brand_submitted', ts: '2026-05-25T00:05:00Z' },
        { event: 'onboarding_completed' },
      ],
    },
    {
      userId: 'u2',
      createdAt: '2026-05-26T00:00:00Z',
      onboardingEvents: [{ event: 'onboarding_skipped' }],
    },
    // Old user — outside the window via createdAt fallback.
    {
      userId: 'u-old',
      createdAt: '2026-01-01T00:00:00Z',
      onboardingEvents: [{ event: 'goal_selected' }],
    },
    // Malformed rows are skipped, not crashed on.
    { userId: 'u3', onboardingEvents: [null, { notEvent: 'x' }, 'string'] as any },
    { onboardingEvents: [{ event: 'orphan' }] }, // no userId
  ];
}

describe('UserArrayEventSource', () => {
  const src = new UserArrayEventSource(async () => users());

  it('normalizes onboardingEvents into the event stream', async () => {
    const evs = await src.fetchEvents(WINDOW);
    const types = evs.map((e) => e.eventType).sort();
    expect(types).toEqual(['brand_submitted', 'goal_selected', 'onboarding_completed', 'onboarding_skipped']);
    expect(evs.every((e) => typeof e.subjectId === 'string')).toBe(true);
  });

  it('falls back to user createdAt when an event has no ts, and respects the window', async () => {
    const evs = await src.fetchEvents(WINDOW);
    // u-old's goal_selected (createdAt 2026-01-01) is outside the window → dropped.
    expect(evs.some((e) => e.subjectId === ('u-old' as any))).toBe(false);
    // u1's events (createdAt in-window) are present.
    expect(evs.filter((e) => e.subjectId === ('u1' as any))).toHaveLength(3);
  });

  it('applies an eventTypes filter', async () => {
    const evs = await src.fetchEvents(WINDOW, { eventTypes: ['onboarding_skipped'] });
    expect(evs).toHaveLength(1);
    expect(evs[0].eventType).toBe('onboarding_skipped');
  });

  it('skips malformed rows and events without a userId without crashing', async () => {
    const evs = await src.fetchEvents(WINDOW);
    expect(evs.some((e) => e.eventType === 'orphan')).toBe(false); // no userId
    // u3's malformed array yields nothing, but doesn't throw.
    expect(evs.some((e) => e.subjectId === ('u3' as any))).toBe(false);
  });

  it('carries extra event fields into dimensions', async () => {
    const withDims = new UserArrayEventSource(async () => [
      { userId: 'd1', createdAt: '2026-05-25T00:00:00Z', onboardingEvents: [{ event: 'deviation', reason: 'back_nav', step: 'channel' }] },
    ]);
    const evs = await withDims.fetchEvents(WINDOW);
    expect(evs[0].dimensions).toEqual({ reason: 'back_nav', step: 'channel' });
  });
});
