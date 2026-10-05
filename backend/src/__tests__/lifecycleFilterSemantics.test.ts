import { matchLifecyclePresenceFilter } from '../utils/lifecycleFilterSemantics';

describe('ENG-2155 lifecycle filter presence semantics', () => {
  it('treats lifecycle as total even when the storage attribute is absent', () => {
    expect(matchLifecyclePresenceFilter('lifecycle', 'is_empty')).toBe(false);
    expect(matchLifecyclePresenceFilter('lifecycle', 'is_not_empty')).toBe(true);
  });

  it('does not claim equality/ordering semantics it cannot derive from a lead row alone', () => {
    expect(matchLifecyclePresenceFilter('lifecycle', 'equals')).toBeUndefined();
    expect(matchLifecyclePresenceFilter('lifecycle', 'not_equals')).toBeUndefined();
    expect(matchLifecyclePresenceFilter('status', 'is_empty')).toBeUndefined();
  });
});
