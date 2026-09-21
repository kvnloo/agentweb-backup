import { normalizeWorkPlanDisplayMetadata } from '../services/workPlanDisplayMetadata';

describe('work plan display metadata', () => {
  const valid = {
    version: 1,
    title: 'Launch a Meta campaign',
    categories: ['paid-ads'],
    nextPlanIds: ['landing-page'],
  };

  it('normalizes a valid author-defined continuation', () => {
    expect(normalizeWorkPlanDisplayMetadata(valid, 3)).toMatchObject(valid);
  });

  it.each([
    [{ ...valid, nextPlanIds: ['landing-page', 'landing-page'] }],
    [{ ...valid, nextPlanIds: [42] }],
    [{ ...valid, categories: ['unknown'] }],
    [{ ...valid, stepLabels: ['one', 'two', 'three', 'four'] }],
  ])('rejects invalid nested metadata %#', (value) => {
    expect(() => normalizeWorkPlanDisplayMetadata(value, 3)).toThrow();
  });

  it('supports existing plans with no display metadata', () => {
    expect(normalizeWorkPlanDisplayMetadata(undefined, 3)).toBeUndefined();
  });

  // ── Relationship-authoring extension (nextPlanIds) ────────────────────────

  it('accepts zero, one, and three next-plan recommendations', () => {
    expect(normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: [] }, 3)).toEqual({ version: 1 });
    expect(normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: ['a'] }, 3)).toMatchObject({ nextPlanIds: ['a'] });
    expect(normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: ['a', 'b', 'c'] }, 3))
      .toMatchObject({ nextPlanIds: ['a', 'b', 'c'] });
  });

  it('rejects more than three next-plan recommendations', () => {
    expect(() => normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: ['a', 'b', 'c', 'd'] }, 3)).toThrow();
  });

  it('rejects a plan recommending itself', () => {
    expect(() =>
      normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: ['own-plan', 'other-plan'] }, 3, 'own-plan'),
    ).toThrow();
  });

  it('does not require the referenced plan to exist or match category/suite', () => {
    // No catalog lookup happens here — a temporarily unresolved or
    // deleted/cross-category target is a runtime-recommender concern, not a
    // save-time validation concern (references may be unresolved during authoring).
    expect(
      normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: ['plan-that-does-not-exist'] }, 3, 'own-plan'),
    ).toMatchObject({ nextPlanIds: ['plan-that-does-not-exist'] });
  });

  it('allows a self-reference check to be skipped when no plan id is known yet (create)', () => {
    // At create time the plan has no id yet, so there is nothing to compare
    // against — the caller simply omits ownPlanId.
    expect(normalizeWorkPlanDisplayMetadata({ version: 1, nextPlanIds: ['a'] }, 3)).toMatchObject({ nextPlanIds: ['a'] });
  });
});
