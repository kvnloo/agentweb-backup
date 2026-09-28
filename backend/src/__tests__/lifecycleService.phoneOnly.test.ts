/**
 * ENG-2082: the visibility fallback only knew about email, so a phone-only capture — an
 * inbound lead the customer paid an ad click for — was filed as 'unknown', the junk bucket,
 * and excluded from the inbox views they actually work.
 */
import { computeLifecycle } from '../services/lifecycleService';

const now = new Date('2026-09-24T00:00:00.000Z');

describe('computeLifecycle — contactability fallback', () => {
  it('files a phone-only lead as inbox, not unknown', () => {
    expect(computeLifecycle({ phone: '2125559876' }, now)).toBe('inbox');
  });

  it('still files an email lead as inbox', () => {
    expect(computeLifecycle({ email: 'ada@example.com' }, now)).toBe('inbox');
  });

  it('leaves a lead with no contact channel as unknown', () => {
    expect(computeLifecycle({}, now)).toBe('unknown');
    expect(computeLifecycle({ domain: 'example.com' }, now)).toBe('unknown');
  });

  it('does not override a stronger stage', () => {
    expect(computeLifecycle({ phone: '2125559876', subscriptionState: 'active' }, now)).toBe('paying');
    expect(computeLifecycle({ phone: '2125559876', hasUserRecord: true }, now)).toBe('signed_up');
  });
});
