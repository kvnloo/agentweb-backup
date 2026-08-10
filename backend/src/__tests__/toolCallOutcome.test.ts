/**
 * ENG-803 — only a call that actually RAN and SUCCEEDED may back a claim about the
 * run, and a generated session title is exactly such a claim.
 *
 * Greptile review #27: a media call deferred because the run exhausted its
 * generation budget carries neither a top-level `error` nor `result.success ===
 * false`, so the title-evidence filter presented it to the summarizer as executed —
 * and the persisted title could claim an asset was produced when nothing ran. That
 * is ENG-803's false-success title ("Replies queued", zero replies posted) reaching
 * the same outcome through a third route.
 *
 * The rule already existed in the finalize guard, which classifies both
 * `duplicateOf` and `result.deferred` as non-backing. It simply was not shared, so
 * the two consumers drifted. These tests pin the shared predicate, including the
 * `duplicateOf` case Greptile did not name — it is the same class of "looks
 * complete, executed nothing".
 */

import { toolCallSucceeded, toolCallNeverExecuted } from '../utils/toolCallOutcome';

describe('toolCallNeverExecuted (ENG-803)', () => {
  it('flags a budget-deferred media call', () => {
    expect(toolCallNeverExecuted({ name: 'generate_image', result: { deferred: true } })).toBe(true);
  });

  it('flags a suppressed same-turn duplicate', () => {
    // The original call has its own ledger entry, so counting this one double-counts.
    expect(toolCallNeverExecuted({ name: 'generate_image', duplicateOf: 'call_123' })).toBe(true);
  });

  it('does not flag a call that genuinely ran', () => {
    expect(toolCallNeverExecuted({ name: 'generate_image', result: { url: 'x' } })).toBe(false);
    expect(toolCallNeverExecuted({ name: 'you_search_web' })).toBe(false);
    expect(toolCallNeverExecuted({ name: 'x', result: { deferred: false } })).toBe(false);
  });

  it('survives malformed entries', () => {
    expect(toolCallNeverExecuted(null)).toBe(false);
    expect(toolCallNeverExecuted(undefined)).toBe(false);
    expect(toolCallNeverExecuted('nope' as any)).toBe(false);
  });
});

describe('toolCallSucceeded (ENG-803)', () => {
  it('rejects the three non-executing shapes', () => {
    expect(toolCallSucceeded({ name: 'twitter_manage_post', error: 'rate limited' })).toBe(false);
    expect(toolCallSucceeded({ name: 'post_on_connected_account', result: { success: false } })).toBe(false);
    expect(toolCallSucceeded({ name: 'generate_image', result: { deferred: true } })).toBe(false);
    expect(toolCallSucceeded({ name: 'generate_image', duplicateOf: 'call_1' })).toBe(false);
  });

  it('accepts a call that ran and succeeded', () => {
    expect(toolCallSucceeded({ name: 'twitter_manage_post', result: { success: true, tweetId: '1' } })).toBe(true);
  });

  it('treats a MISSING success flag as success', () => {
    // Most tools return a payload rather than {success}. Treating an absent flag as
    // failure would erase nearly every tool from the evidence and make every title
    // read as though nothing happened.
    expect(toolCallSucceeded({ name: 'get_brand_guidelines', result: { guidelines: 'x' } })).toBe(true);
    expect(toolCallSucceeded({ name: 'you_search_web' })).toBe(true);
  });

  it('reproduces the reported ledger: nothing publishable survives', () => {
    const ledger = [
      { name: 'twitter_outreach', result: { success: true } },
      { name: 'twitter_manage_post', error: 'gate' },
      { name: 'twitter_manage_post', result: { success: false } },
      { name: 'generate_image', result: { deferred: true } },
    ];
    expect(ledger.filter(toolCallSucceeded).map((c) => c.name)).toEqual(['twitter_outreach']);
  });

  it('survives malformed entries', () => {
    expect(toolCallSucceeded(null)).toBe(false);
    expect(toolCallSucceeded(undefined)).toBe(false);
  });
});
