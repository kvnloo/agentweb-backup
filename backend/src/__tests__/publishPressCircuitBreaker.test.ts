import {
  MAX_PUBLISH_PRESS_ATTEMPTS,
  isPublishOnlyUnmet,
  shouldStopPressingForPublish,
} from '../utils/publishPressCircuitBreaker';

describe('shouldStopPressingForPublish (ENG-947)', () => {
  const press = (over: Partial<Parameters<typeof shouldStopPressingForPublish>[0]> = {}) =>
    shouldStopPressingForPublish({
      pressAttempt: MAX_PUBLISH_PRESS_ATTEMPTS,
      unmetRequiredFunctions: ['post_on_connected_account'],
      ...over,
    });

  it('trips once the press budget is spent and the only unmet requirement is a publish tool', () => {
    expect(press()).toBe(true);
    expect(press({ pressAttempt: MAX_PUBLISH_PRESS_ATTEMPTS + 5 })).toBe(true);
  });

  it('leaves the early presses alone — a run that complies on a later attempt must still get there', () => {
    for (let pressAttempt = 1; pressAttempt < MAX_PUBLISH_PRESS_ATTEMPTS; pressAttempt++) {
      expect(press({ pressAttempt })).toBe(false);
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
    expect(press({ pressAttempt: 2, maxPressAttempts: 2 })).toBe(true);
    expect(press({ pressAttempt: 2, maxPressAttempts: 9 })).toBe(false);
  });
});

describe('isPublishOnlyUnmet (ENG-947)', () => {
  it('is true only when every outstanding requirement is a publish tool', () => {
    expect(isPublishOnlyUnmet(['post_on_connected_account'])).toBe(true);
    expect(isPublishOnlyUnmet(['post_on_connected_account', 'publish_blog_article'])).toBe(true);
    expect(isPublishOnlyUnmet(['post_on_connected_account', 'get_marketing_tips'])).toBe(false);
    expect(isPublishOnlyUnmet(['generate_image'])).toBe(false);
  });

  it('is false for an empty, missing or malformed set — the press counter must not advance on it', () => {
    expect(isPublishOnlyUnmet([])).toBe(false);
    expect(isPublishOnlyUnmet(undefined as any)).toBe(false);
    expect(isPublishOnlyUnmet([null as any])).toBe(false);
  });
});
