/**
 * Unit tests for the PURE Gemini reasoning-leak detector (ENG-737).
 *
 * The shapes below mirror the production session d103071a-…-f118f50eb366:
 * gemini-3.5-flash truncated its answer mid-reasoning; fragments 29/30 opened with
 * a lowercase `thought` marker, and their continuation 31 was a MARKERLESS repeated
 * query loop — all leaked into the chat. No real customer data is embedded here.
 *
 * The detector fires ONLY on a TRUNCATED (finish_reason='length') Gemini turn, and
 * only via (1) a lowercase `thought` marker, or (2) a degenerate loop that directly
 * continues an already-suppressed leak. So a COMPLETED answer, a truncated real
 * prose answer, and standalone repetitive content are all left untouched.
 */

import {
  isReasoningLeak,
  hasLeadingThoughtMarker,
  hasDegenerateRepeatedLine,
  type LeakedReasoningInput,
} from '../reasoningLeak';

const REPEATED_QUERY =
  'Wait, let\'s search for "Some Person" "Some Org" or "Alt Org" on Google or other search engines.';

const LEAKED_THOUGHT =
  'thought\nWait, the search results are looping. Let\'s look at what we found.\n' +
  Array(6).fill(REPEATED_QUERY).join('\n');

// The markerless continuation fragment (session d103071a fragment 31): no leading
// `thought` marker, but a degenerate repeated-query loop.
const MARKERLESS_LOOP =
  '\n*   Wait, let\'s look at the search results we got:\n' +
  Array(6).fill('    - ' + REPEATED_QUERY).join('\n');

const CLEAN_ANSWER =
  "\nI've gathered the public background information you asked for.\n\n" +
  '<h3>1. Professional Profile</h3>\n<ul><li><strong>Specialty:</strong> Anesthesiology</li></ul>';

const base: LeakedReasoningInput = {
  finishReason: 'length',
  content: LEAKED_THOUGHT,
  hasThoughtSignature: true,
  model: 'gemini-3.5-flash',
};

describe('hasLeadingThoughtMarker', () => {
  it('fires when the first non-blank line is exactly the lowercase word "thought"', () => {
    expect(hasLeadingThoughtMarker('thought\nLet me reconsider.')).toBe(true);
    expect(hasLeadingThoughtMarker('\n\n  thought\nmore')).toBe(true);
  });

  it('does NOT fire on a capitalized "Thought" heading (case-sensitive — never a real heading)', () => {
    expect(hasLeadingThoughtMarker('Thought\nA reflection on the strategy.')).toBe(false);
    expect(hasLeadingThoughtMarker('THOUGHT\nsomething')).toBe(false);
  });

  it('does NOT fire when "thought" is only a prefix of a longer first line', () => {
    expect(hasLeadingThoughtMarker('thought leadership is a strategy')).toBe(false);
    expect(hasLeadingThoughtMarker('Thoughts on the plan:')).toBe(false);
  });

  it('returns false on empty content', () => {
    expect(hasLeadingThoughtMarker('')).toBe(false);
  });
});

describe('hasDegenerateRepeatedLine', () => {
  it('detects a long line repeated 4+ times consecutively', () => {
    expect(hasDegenerateRepeatedLine(Array(4).fill(REPEATED_QUERY).join('\n'))).toBe(true);
  });

  it('does not fire on 3 repeats (below threshold)', () => {
    expect(hasDegenerateRepeatedLine(Array(3).fill(REPEATED_QUERY).join('\n'))).toBe(false);
  });

  it('ignores short/trivial repeated lines and does not treat spaced duplicates as a loop', () => {
    expect(hasDegenerateRepeatedLine('---\n---\n---\n---\n---')).toBe(false);
    expect(hasDegenerateRepeatedLine([REPEATED_QUERY, 'unique line', REPEATED_QUERY, 'other'].join('\n'))).toBe(false);
  });
});

describe('isReasoningLeak', () => {
  it('suppresses a truncated gemini turn that leaked its chain-of-thought (thought marker)', () => {
    expect(isReasoningLeak(base)).toBe(true);
  });

  it('does NOT suppress the final, non-truncated answer turn (finish_reason=stop)', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'stop', content: CLEAN_ANSWER })).toBe(false);
  });

  it('does NOT suppress a normal truncated answer fragment (no thought marker, not a leak continuation)', () => {
    expect(
      isReasoningLeak({
        ...base,
        content: 'Here is the first half of a long, legitimate answer that ran out of tokens',
      }),
    ).toBe(false);
  });

  // The markerless continuation (fragment 31): a degenerate loop that directly
  // follows an already-suppressed leak IS caught.
  it('suppresses a markerless degenerate loop that continues a just-suppressed leak', () => {
    expect(
      isReasoningLeak({ ...base, content: MARKERLESS_LOOP, precededBySuppressedLeak: true }),
    ).toBe(true);
  });

  // But the SAME degenerate-loop content standalone (not continuing a leak) is NOT
  // suppressed — this is what protects legitimate repeated data / template / code.
  it('does NOT suppress a standalone degenerate loop that does not follow a suppressed leak', () => {
    expect(
      isReasoningLeak({ ...base, content: MARKERLESS_LOOP, precededBySuppressedLeak: false }),
    ).toBe(false);
  });

  // A truncated REAL prose answer following a leak (no degenerate loop) is NOT
  // suppressed even mid-chain — protects a genuine partial answer.
  it('does NOT suppress a truncated real prose answer even when it follows a suppressed leak', () => {
    expect(
      isReasoningLeak({
        ...base,
        content: 'Here is the first half of the real answer, which simply ran out of tokens mid-sentence',
        precededBySuppressedLeak: true,
      }),
    ).toBe(false);
  });

  it('does NOT suppress a leak-continuation loop once the turn completes (finish_reason=stop)', () => {
    expect(
      isReasoningLeak({ ...base, content: MARKERLESS_LOOP, finishReason: 'stop', precededBySuppressedLeak: true }),
    ).toBe(false);
  });

  it('does NOT touch non-gemini providers, even when truncated with a leak-shaped body', () => {
    expect(
      isReasoningLeak({
        finishReason: 'length',
        content: LEAKED_THOUGHT,
        hasThoughtSignature: false,
        model: 'anthropic.claude-opus-4-8',
      }),
    ).toBe(false);
  });

  it('fires for a gemini-* model even without a thought_signature present', () => {
    expect(
      isReasoningLeak({ ...base, hasThoughtSignature: false, model: 'gemini-3.5-flash' }),
    ).toBe(true);
  });

  it('does NOT suppress a `thought` preamble on a completed tool-call turn (finish_reason=tool_calls)', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'tool_calls' })).toBe(false);
  });
});
