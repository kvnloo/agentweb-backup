/**
 * Unit tests for the PURE Gemini reasoning-leak detector (ENG-737).
 *
 * This is the compat-path FALLBACK ONLY — the primary path (native @google/genai
 * adapter, default ON) prevents the leak structurally. The shapes below mirror
 * production session d103071a-…-f118f50eb366: gemini-3.5-flash truncated its
 * answer mid-reasoning; fragments 29/30 opened with a lowercase `thought` marker.
 * No real customer data is embedded here.
 *
 * The detector fires ONLY on a TRUNCATED (finish_reason='length') Gemini turn
 * whose content opens with a lowercase `thought` marker. So a COMPLETED answer, a
 * truncated real prose answer, and standalone repetitive content are all left
 * untouched.
 */

import {
  isReasoningLeak,
  hasLeadingThoughtMarker,
  type LeakedReasoningInput,
} from '../reasoningLeak';

const REPEATED_QUERY =
  'Wait, let\'s search for "Some Person" "Some Org" or "Alt Org" on Google or other search engines.';

const LEAKED_THOUGHT =
  'thought\nWait, the search results are looping. Let\'s look at what we found.\n' +
  Array(6).fill(REPEATED_QUERY).join('\n');

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

describe('isReasoningLeak', () => {
  it('suppresses a truncated gemini turn that leaked its chain-of-thought (thought marker)', () => {
    expect(isReasoningLeak(base)).toBe(true);
  });

  it('does NOT suppress the final, non-truncated answer turn (finish_reason=stop)', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'stop', content: CLEAN_ANSWER })).toBe(false);
  });

  it('does NOT suppress a normal truncated answer fragment (no thought marker)', () => {
    expect(
      isReasoningLeak({
        ...base,
        content: 'Here is the first half of a long, legitimate answer that ran out of tokens',
      }),
    ).toBe(false);
  });

  // Standalone repetitive content (template rows, repeated data, code) is never
  // suppressed — the detector only looks at the leading marker, never at shape.
  it('does NOT suppress standalone repeated/degenerate-looking content (no thought marker)', () => {
    expect(
      isReasoningLeak({
        ...base,
        content: Array(6).fill(REPEATED_QUERY).join('\n'),
      }),
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
