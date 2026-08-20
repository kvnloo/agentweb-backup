/**
 * ENG-947 — an irreversible publish that FAILED must not satisfy a schedule's
 * `requiredFunctionCalls`.
 *
 * Verified live on the preview environment 2026-08-11: a scheduled run whose
 * `post_on_connected_account` call returned
 *   "Tool Error: Multiple twitter accounts connected"
 * published nothing, and was still stored as `status: success`, `passed: true`,
 * `functionCallMatches: ['post_on_connected_account']`. runVerifiedChat builds its
 * requirement ledger from `toolCalls.map(c => c.name)`, so an ATTEMPT counts the
 * same as a SEND.
 *
 * ENG-803 already wrote the correct predicate for this (`toolCallSucceeded`) and
 * wired it into the session-title summary only — its own tests name
 * `post_on_connected_account` explicitly while the gate that decides pass/fail
 * never consults it. This is that same false-success, one layer down.
 *
 * SCOPED TO PUBLISH TOOLS ON PURPOSE. Requiring success for every tool would
 * change pass/fail for every scheduled run with `requiredFunctionCalls` — many
 * would start failing and retrying — which is a product decision, not a bug fix.
 * An irreversible external publish is the case where "it was attempted" and "it
 * happened" are genuinely different facts to the schedule's owner, so only that
 * family is tightened here. The non-publish behaviour is pinned below so a later
 * change cannot widen it by accident.
 */

import { countsTowardRequirement, requirementEvidenceNames } from '../utils/toolCallOutcome';

describe('countsTowardRequirement (ENG-947)', () => {
  it('rejects a publish that reported a top-level error', () => {
    // The exact shape the preview run persisted.
    expect(countsTowardRequirement({
      name: 'post_on_connected_account',
      result: {},
      error: 'Multiple twitter accounts connected. Call list_connected_accounts…',
    })).toBe(false);
  });

  it('rejects a publish whose preflight came back success:false', () => {
    expect(countsTowardRequirement({ name: 'publish_blog_post', result: { success: false } })).toBe(false);
  });

  it('rejects a publish that never executed at all', () => {
    expect(countsTowardRequirement({ name: 'post_on_connected_account', result: { deferred: true } })).toBe(false);
    expect(countsTowardRequirement({ name: 'post_on_connected_account', duplicateOf: 'call_1' })).toBe(false);
  });

  it('rejects malformed entries rather than reading them as a publish', () => {
    expect(countsTowardRequirement(null)).toBe(false);
    expect(countsTowardRequirement(undefined)).toBe(false);
    expect(countsTowardRequirement('post_on_connected_account' as any)).toBe(false);
  });

  it('accepts a publish that actually landed', () => {
    expect(countsTowardRequirement({
      name: 'post_on_connected_account',
      result: { success: true, tweetId: '1' },
    })).toBe(true);
  });

  it('accepts a publish that returned a payload with no success flag', () => {
    // Most tools return a payload rather than {success}; treating an absent flag as
    // failure would erase real publishes from the ledger (ENG-803's reasoning).
    expect(countsTowardRequirement({ name: 'post_on_connected_account', result: { postId: 'x' } })).toBe(true);
  });

  it('leaves NON-publish tools on the old attempted-counts rule', () => {
    // The scope guard. A failed read/search still satisfies its requirement exactly
    // as it did before, so no non-publish schedule changes behaviour.
    expect(countsTowardRequirement({ name: 'analyze_competitors', error: 'upstream 500' })).toBe(true);
    expect(countsTowardRequirement({ name: 'describe_image', result: { success: false } })).toBe(true);
    expect(countsTowardRequirement({ name: 'you_search_web' })).toBe(true);
  });
});

describe('requirementEvidenceNames (ENG-947)', () => {
  it('drops only the failed publishes from a mixed ledger', () => {
    const ledger = [
      { name: 'update_knowledge_base_file', result: { success: true } },
      { name: 'post_on_connected_account', error: 'Multiple twitter accounts connected' },
      { name: 'analyze_competitors', error: 'upstream 500' },
      { name: 'post_on_connected_account', result: { success: true } },
    ];
    expect(requirementEvidenceNames(ledger)).toEqual([
      'update_knowledge_base_file',
      'analyze_competitors',
      'post_on_connected_account',
    ]);
  });

  it('reproduces the preview run: a lone failed publish leaves NO evidence', () => {
    expect(requirementEvidenceNames([
      { name: 'post_on_connected_account', result: {}, error: 'Multiple twitter accounts connected' },
    ])).toEqual([]);
  });

  it('survives a missing or malformed ledger', () => {
    expect(requirementEvidenceNames(undefined as any)).toEqual([]);
    expect(requirementEvidenceNames([null, undefined, { noName: true }] as any)).toEqual([]);
  });
});

// The alias/equivalence-route behavior that used to be tested here (thread-post
// substitute, email send substitute, double-credit suppression, JSON-string
// arguments handling) was consolidated into requiredCallSatisfaction.ts's
// callSatisfiesRequirement/countCallsSatisfyingRequirement during the ENG-1045 x
// ENG-1276 merge — ONE shared equivalence table instead of two independently
// evolving ones (this file's requirementEvidenceNames no longer computes aliases
// at all). See requiredCallSatisfaction.test.ts for that coverage.
