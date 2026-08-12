import {
  MAX_PUBLISH_PRESS_ATTEMPTS,
  isPublishOnlyUnmet,
  shouldStopPressingForPublish,
  classifyPublishStall,
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

/**
 * ENG-947 — a stalled publish requirement has TWO causes, and calling both
 * "held for approval" reports a live post as unpublished.
 *
 * Production case, schedule 34154af9 "Kevin — X Evening Post", run
 * 2026-08-11T08:07:26Z: requiredFunctionCalls names post_on_connected_account,
 * but the prompt asks for a 2-3 tweet THREAD, so the model used
 * twitter_manage_post instead — once, successfully, summary "Thread Published".
 * post_on_connected_account stayed at actual 0, so the requirement was unmet and
 * the run pressed to attempt 20.
 *
 * The breaker is right to stop pressing there — re-asking for a tool the model
 * has already worked around is exactly as futile as re-asking for a refused one.
 * But the run DID publish, so marking it publishHeldForApproval would tell the
 * owner their thread is waiting for approval while it is live on X. The two
 * cases need different answers: one is "approve it", the other is "your schedule
 * names the wrong tool".
 */
describe('classifyPublishStall (ENG-947)', () => {
  const classify = (over: Partial<Parameters<typeof classifyPublishStall>[0]> = {}) =>
    classifyPublishStall({
      pressAttempt: MAX_PUBLISH_PRESS_ATTEMPTS,
      unmetRequiredFunctions: ['post_on_connected_account'],
      externalWritesSucceeded: [],
      ...over,
    });

  it('keeps pressing while the budget is unspent, whatever else happened', () => {
    expect(classify({ pressAttempt: 1 })).toBeNull();
    expect(classify({ pressAttempt: 1, externalWritesSucceeded: ['twitter_manage_post'] })).toBeNull();
  });

  it('keeps pressing when something reversible is also outstanding', () => {
    expect(classify({ unmetRequiredFunctions: ['post_on_connected_account', 'analyze_competitors'] })).toBeNull();
  });

  it('reports a genuine withhold when the run published nothing', () => {
    expect(classify()).toBe('held-for-approval');
  });

  it('reports a TOOL MISMATCH when the run published through a different tool', () => {
    // The real 2026-08-11 evening run.
    expect(classify({ externalWritesSucceeded: ['twitter_manage_post'] })).toBe(
      'requirement-names-unused-publish-tool',
    );
  });

  it('ignores a FAILED external write — nothing was published, so it is still a withhold', () => {
    // Callers pass only succeeded writes; this pins the contract at the boundary.
    expect(classify({ externalWritesSucceeded: [] })).toBe('held-for-approval');
  });

  it('does not treat the unmet tool itself as evidence it published', () => {
    // Defensive: if a caller ever passed the unmet name through, the run plainly
    // did NOT succeed at it (that is why it is unmet), so this must not flip to
    // mismatch and silently suppress the approval signal.
    expect(classify({ externalWritesSucceeded: ['post_on_connected_account'] })).toBe(
      'held-for-approval',
    );
  });

  it('ignores non-write tools entirely', () => {
    expect(classify({ externalWritesSucceeded: ['you_search_web', 'save_memory'] })).toBe(
      'held-for-approval',
    );
  });
});
