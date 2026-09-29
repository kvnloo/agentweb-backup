import {
  derivedLifecycleValue,
  matchesDerivedLifecycleFilter,
} from '../experiments/derivedLifecycleFilter';

const NOW = new Date('2026-09-29T18:00:00.000Z');

describe('A11 derived lifecycle filtering', () => {
  it('does not treat an unstamped but contactable lead as lifecycle-empty', () => {
    const lead = { email: 'a@example.com', lifecycle: null };
    expect(derivedLifecycleValue(lead, NOW)).toBe('inbox');
    expect(matchesDerivedLifecycleFilter(lead, { operator: 'is_empty' }, NOW)).toBe(false);
    expect(matchesDerivedLifecycleFilter(lead, { operator: 'is_not_empty' }, NOW)).toBe(true);
  });

  it('maps truly sparse rows to unknown instead of empty', () => {
    const lead = { lifecycle: null };
    expect(derivedLifecycleValue(lead, NOW)).toBe('unknown');
    expect(matchesDerivedLifecycleFilter(lead, { operator: 'equals', value: 'unknown' }, NOW)).toBe(true);
    expect(matchesDerivedLifecycleFilter(lead, { operator: 'is_empty' }, NOW)).toBe(false);
  });

  it('lets live subscription state outrank a stale stored snapshot', () => {
    const lead = {
      email: 'paying@example.com',
      lifecycle: 'inbox' as const,
      subscriptionState: 'active' as const,
    };
    expect(matchesDerivedLifecycleFilter(lead, { operator: 'equals', value: 'paying' }, NOW)).toBe(true);
    expect(matchesDerivedLifecycleFilter(lead, { operator: 'equals', value: 'inbox' }, NOW)).toBe(false);
  });

  it('preserves at-risk stickiness context while recomputing', () => {
    const lead = {
      email: 'risk@example.com',
      lifecycle: 'paying' as const,
      healthScore: 20,
    };
    expect(derivedLifecycleValue(lead, NOW)).toBe('at_risk');
  });
});
