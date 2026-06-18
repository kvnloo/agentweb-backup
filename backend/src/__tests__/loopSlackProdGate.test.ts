/**
 * Loop Slack egress gate (2026-06-13).
 *
 * Best-practice fix for the "Emma Dev yaps" incident: a dev/test backend with a
 * loop flag flipped on was able to DM the founder via the shared emma_dev token.
 * Side effects that leave the system must be structurally impossible outside
 * prod, not merely gated by a per-loop flag someone has to remember to unset.
 *
 * This gates the loops' Slack egress on a positive prod Slack target, not on
 * NODE_ENV alone. Dev EC2s often run NODE_ENV=production for optimized Node
 * behavior, and that must not be enough to DM humans from Emma Dev.
 */

import { shouldSuppressLoopSlackPost } from '../loops/adapters/awsAdapters';

describe('shouldSuppressLoopSlackPost', () => {
  it('suppresses even NODE_ENV=production without an explicit prod Slack target', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production' })).toBe(true);
  });

  it('allows posting only with the explicit prod Slack target', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production', LOOP_SLACK_EGRESS_TARGET: 'prod' })).toBe(false);
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production', LOOP_SLACK_EGRESS_TARGET: 'production' })).toBe(false);
  });

  it('suppresses in development by default', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development' })).toBe(true);
  });

  it('suppresses in staging/test by default', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'staging' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'test' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({})).toBe(true);
  });

  it('allows non-prod posting only with the explicit testing override', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development', LOOP_SLACK_ALLOW_NONPROD: 'true' })).toBe(false);
  });

  it('suppresses non-prod targets unless the testing override is set', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production', LOOP_SLACK_EGRESS_TARGET: 'dev' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'production', LOOP_SLACK_TARGET: 'staging' })).toBe(true);
  });

  it('treats any non-"true" override value as off', () => {
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development', LOOP_SLACK_ALLOW_NONPROD: '1' })).toBe(true);
    expect(shouldSuppressLoopSlackPost({ NODE_ENV: 'development', LOOP_SLACK_ALLOW_NONPROD: 'yes' })).toBe(true);
  });
});
