/**
 * ENG-918 — storage-layer conversion rules.
 *
 * `itemToParameter` is pure (no AWS calls inside it), so it's tested directly rather than through
 * `getThreshold`/`getThresholdsForAccount`, which would need the whole DynamoDB client mocked to
 * exercise the same branch.
 */

import { itemToParameter } from '../services/adsThresholdsDb';

function item(overrides: Record<string, unknown> = {}) {
  return {
    entityKey: 'meta#1842363582956923',
    paramKey: 'creativeFatigue.frequencyCritical',
    currentValue: 3.5,
    source: 'user',
    updatedAt: '2026-09-01T00:00:00.000Z',
    revisions: [],
    ...overrides,
  };
}

describe('itemToParameter — corrupted data fails loud, not silently', () => {
  it('converts a well-formed item', () => {
    const parsed = itemToParameter(item());
    expect(parsed).toMatchObject({
      accountId: '1842363582956923',
      platform: 'meta',
      paramKey: 'creativeFatigue.frequencyCritical',
      currentValue: 3.5,
      source: 'user',
    });
  });

  it('returns null for an unparseable entity key rather than throwing', () => {
    // Entity-key parsing already has its own well-tested null-on-malformed contract
    // (parseThresholdEntityKey); this just confirms itemToParameter respects it.
    expect(itemToParameter(item({ entityKey: 'malformed-no-separator' }))).toBeNull();
  });

  it.each([undefined, 'not-a-number', {}])(
    'throws rather than silently producing NaN when currentValue is %p',
    badValue => {
      // Number(undefined) / Number('not-a-number') / Number({}) are all NaN, and NaN silently
      // defeats every bounds/movement-cap comparison downstream — Number(x) < min and
      // Number(x) > max are both false for NaN, so a corrupted item would sail through every
      // guarantee this store exists to provide.
      expect(() => itemToParameter(item({ currentValue: badValue }))).toThrow(/non-finite/);
    },
  );

  it('throws for a null currentValue specifically — Number(null) is 0, NOT NaN', () => {
    // The tempting guard (`!Number.isFinite(Number(x))`) alone does not catch this: Number(null)
    // converts to the real, finite number 0, so a missing attribute would silently read as a
    // plausible "the threshold is 0" instead of failing loud. This needs its own explicit check.
    expect(() => itemToParameter(item({ currentValue: null }))).toThrow(/non-finite/);
  });

  it('accepts a numeric-string currentValue (DynamoDB Number attributes deserialize this way sometimes)', () => {
    const parsed = itemToParameter(item({ currentValue: '4.2' }));
    expect(parsed?.currentValue).toBe(4.2);
  });
});
