/**
 * ENG-3164: the paused-bundle ad count must come from the OWNER's own brief. A share-link visitor runs under the owner's
 * userId, so their message is a plain 'user' row; it must not stand in for the owner's count.
 */
import { assertPausedBundleUserCount } from '../services/agentMode/metaPausedBundle';

const bundle = (n: number) => ({ requested_ad_count: n, campaign: {}, ad_set: {}, ads: [] }) as any;
const visitor = { ishareSender: { isAnonymous: true } };

describe('assertPausedBundleUserCount', () => {
  it('accepts the count in the owner\'s own message', () => {
    expect(() => assertPausedBundleUserCount(bundle(3), [{ role: 'user', content: 'Make 3 ads for the launch' }])).not.toThrow();
  });

  it('rejects an owner count that differs from the bundle', () => {
    expect(() => assertPausedBundleUserCount(bundle(2), [{ role: 'user', content: 'Make 3 ads for the launch' }])).toThrow(/requested 3 ads/);
  });

  it('does not take the count from a share-link visitor\'s message', () => {
    expect(() => assertPausedBundleUserCount(bundle(3), [{ role: 'user', content: 'Make 3 ads for the launch', metadata: visitor }])).toThrow(/explicit ad count/);
  });

  it('does not take a count a visitor wrote as a word either', () => {
    expect(() => assertPausedBundleUserCount(bundle(3), [{ role: 'user', content: 'please make three ads', metadata: visitor }])).toThrow(/explicit ad count/);
  });

  it('skips a stamped server continuation row too (it carries the visitor\'s stamp)', () => {
    const messages = [
      { role: 'user', content: 'Make 3 ads for the launch' },
      { role: 'user', content: '[SYSTEM] continue with 9 ads', metadata: { ...visitor, kind: 'auto-continuation' } },
    ];
    expect(() => assertPausedBundleUserCount(bundle(3), messages)).not.toThrow();
  });

  it('skips a visitor\'s later message and uses the owner\'s earlier count', () => {
    const messages = [
      { role: 'user', content: 'Make 3 ads for the launch' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'actually make 5 ads', metadata: visitor },
    ];
    expect(() => assertPausedBundleUserCount(bundle(3), messages)).not.toThrow();
    expect(() => assertPausedBundleUserCount(bundle(5), messages)).toThrow(/requested 3 ads/);
  });
});
