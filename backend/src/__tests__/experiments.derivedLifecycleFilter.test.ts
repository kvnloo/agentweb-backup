import { matchesLifecyclePresenceFilter } from '../experiments/derivedLifecycleFilter';

describe('A11a lifecycle presence semantics', () => {
  it('never equates missing storage with an empty lifecycle', () => {
    expect(matchesLifecyclePresenceFilter({ operator: 'is_empty' })).toBe(false);
    expect(matchesLifecyclePresenceFilter({ operator: 'is_not_empty' })).toBe(true);
  });

  it('abstains on equality until live signals are joined', () => {
    expect(matchesLifecyclePresenceFilter({ operator: 'equals', value: 'paying' })).toBeUndefined();
    expect(matchesLifecyclePresenceFilter({ operator: 'not_equals', value: 'inbox' })).toBeUndefined();
  });
});
