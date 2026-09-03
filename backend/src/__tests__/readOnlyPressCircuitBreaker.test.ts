import {
  MAX_READ_ONLY_PRESS_ATTEMPTS,
  isReadOnlyOnlyUnmet,
  shouldStopPressingForReadOnly,
} from '../utils/readOnlyPressCircuitBreaker';

describe('shouldStopPressingForReadOnly (ENG-1297)', () => {
  const press = (over: Partial<Parameters<typeof shouldStopPressingForReadOnly>[0]> = {}) =>
    shouldStopPressingForReadOnly({
      pressAttempt: MAX_READ_ONLY_PRESS_ATTEMPTS,
      unmetRequiredFunctions: ['you_search_web'],
      ...over,
    });

  it('trips once the (small) press budget is spent and the only unmet requirement is read-only', () => {
    expect(press()).toBe(true);
    expect(press({ pressAttempt: MAX_READ_ONLY_PRESS_ATTEMPTS + 5 })).toBe(true);
  });

  it('allows exactly one nudge before stopping — the ENG-1297 fix recommendation', () => {
    // pressAttempt=1 is the initial turn reaching this state (no nudge sent yet).
    expect(press({ pressAttempt: 1 })).toBe(false);
    // pressAttempt=2 is after the first (and only) nudge has been sent and answered.
    expect(press({ pressAttempt: 2 })).toBe(true);
  });

  it('never trips when nothing is unmet', () => {
    expect(press({ unmetRequiredFunctions: [] })).toBe(false);
    expect(press({ unmetRequiredFunctions: undefined as any })).toBe(false);
  });

  it('never trips while a write requirement is also unmet — pressing for those still has value', () => {
    expect(press({ unmetRequiredFunctions: ['you_search_web', 'post_on_connected_account'] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['generate_image'] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['notify_session'] })).toBe(false);
  });

  it('covers read-only tools by exact name and by leading read-verb prefix', () => {
    expect(press({ unmetRequiredFunctions: ['you_search_web'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['perform_data_analysis'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['get_marketing_tips'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['search_leads'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['you_search_web', 'get_marketing_tips'] })).toBe(true);
  });

  it('ignores malformed entries rather than tripping on them', () => {
    expect(press({ unmetRequiredFunctions: [null as any] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['you_search_web', undefined as any] })).toBe(false);
  });

  it('honours an explicit press budget override', () => {
    expect(press({ pressAttempt: 1, maxPressAttempts: 1 })).toBe(true);
    expect(press({ pressAttempt: 1, maxPressAttempts: 3 })).toBe(false);
  });
});

describe('isReadOnlyOnlyUnmet (ENG-1297)', () => {
  it('is false for an empty or malformed set', () => {
    expect(isReadOnlyOnlyUnmet([])).toBe(false);
    expect(isReadOnlyOnlyUnmet(undefined as any)).toBe(false);
    expect(isReadOnlyOnlyUnmet(null as any)).toBe(false);
  });

  it('is true only when every unmet name is read-only', () => {
    expect(isReadOnlyOnlyUnmet(['you_search_web'])).toBe(true);
    expect(isReadOnlyOnlyUnmet(['you_search_web', 'get_marketing_tips'])).toBe(true);
    expect(isReadOnlyOnlyUnmet(['you_search_web', 'post_on_connected_account'])).toBe(false);
  });
});
