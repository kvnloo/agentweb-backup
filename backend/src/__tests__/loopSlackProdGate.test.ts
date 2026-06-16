/**
 * Loop Slack egress gate (2026-06-13).
 *
 * Best-practice fix for the "Emma Dev yaps" incident: a dev/test backend with a
 * loop flag flipped on was able to DM the founder via the shared emma_dev token.
 * Side effects that leave the system must be structurally impossible outside
 * prod, not merely gated by a per-loop flag someone has to remember to unset.
 *
 * This gates the loops' Slack egress on a positive prod signal, overridable for
 * intentional dev testing via LOOP_SLACK_ALLOW_NONPROD=true.
 */

import { shouldSuppressLoopSlackPost } from '../loops/adapters/awsAdapters';

describe('shouldSuppressLoopSlackPost', () => {
  it('allows posting in production', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production' })).toBe(false);
  });

  it('suppresses in development by default', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development' })).toBe(true);
  });

  it('suppresses in staging/test by default', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'staging' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'test' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({})).toBe(true);
  });

  it('allows non-prod posting only with the explicit override', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development', LOOP_SLACK_ALLOW_NONPROD: 'true' })).toBe(false);
  });

  it('the override does nothing in prod (already allowed)', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production', LOOP_SLACK_ALLOW_NONPROD: 'true' })).toBe(false);
  });

  it('treats any non-"true" override value as off', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development', LOOP_SLACK_ALLOW_NONPROD: '1' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development', LOOP_SLACK_ALLOW_NONPROD: 'yes' })).toBe(true);
  });
});
