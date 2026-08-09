import {
  MAX_PUBLISH_PRESS_ATTEMPTS,
  shouldStopPressingForPublish,
} from '../utils/publishPressCircuitBreaker';

describe('shouldStopPressingForPublish (ENG-947)', () => {
  const press = (over: Partial<Parameters<typeof shouldStopPressingForPublish>[0]> = {}) =>
    shouldStopPressingForPublish({
      attempt: MAX_PUBLISH_PRESS_ATTEMPTS,
      unmetRequiredFunctions: ['post_on_connected_account'],
      ...over,
    });

  it('trips once the press budget is spent and the only unmet requirement is a publish tool', () => {
    expect(press()).toBe(true);
    expect(press({ attempt: MAX_PUBLISH_PRESS_ATTEMPTS + 5 })).toBe(true);
  });

  it('leaves the early presses alone — a run that complies on a later attempt must still get there', () => {
    for (let attempt = 1; attempt < MAX_PUBLISH_PRESS_ATTEMPTS; attempt++) {
      expect(press({ attempt })).toBe(false);
    }
  });

  it('never trips when nothing is unmet', () => {
    expect(press({ unmetRequiredFunctions: [] })).toBe(false);
    expect(press({ unmetRequiredFunctions: undefined as any })).toBe(false);
  });

  it('never trips while a NON-publish requirement is also unmet — pressing for those is cheap and reversible', () => {
    expect(press({ unmetRequiredFunctions: ['post_on_connected_account', 'analyze_competitors'] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['get_marketing_tips'] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['generate_image'] })).toBe(false);
  });

  it('covers the whole publish family, including prefix-matched tools registered later', () => {
    expect(press({ unmetRequiredFunctions: ['publish_blog_article'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['publish_landing_page_changes'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['post_on_account'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['post_on_some_future_network'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['publish_some_future_surface'] })).toBe(true);
    expect(
      press({ unmetRequiredFunctions: ['post_on_connected_account', 'publish_blog_article'] })
    ).toBe(true);
  });

  it('ignores malformed entries rather than tripping on them', () => {
    expect(press({ unmetRequiredFunctions: [null as any] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['post_on_connected_account', undefined as any] })).toBe(false);
  });

  it('honours an explicit press budget override', () => {
    expect(press({ attempt: 2, maxPressAttempts: 2 })).toBe(true);
    expect(press({ attempt: 2, maxPressAttempts: 9 })).toBe(false);
  });
});
