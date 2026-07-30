/**
 * Unit tests for the PURE Gemini reasoning-leak detector (ENG-737).
 *
 * The shapes below mirror the production session d103071a-…-f118f50eb366:
 * gemini-3.5-flash truncated its answer mid-reasoning and the OpenAI-compat
 * endpoint returned the raw chain-of-thought — prefixed with a bare lowercase
 * `thought` part marker — as the assistant content, which leaked into the chat.
 * No real customer data is embedded here.
 *
 * The detector is deliberately narrow: it fires ONLY on a TRUNCATED
 * (finish_reason='length') Gemini turn whose content opens with a lowercase
 * `thought` marker, so a COMPLETED answer — or any content it might merely
 * misclassify by shape — is never blanked.
 */

import {
  isReasoningLeak,
  hasLeadingThoughtMarker,
  type LeakedReasoningInput,
} from '../reasoningLeak';

const LEAKED_THOUGHT =
  'thought\nWait, the search results are looping. Let\'s look at what we found.\n' +
  'Wait, let\'s search for "Some Person" "Some Org" again on Google.';

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
  it('suppresses a truncated gemini thinking turn that leaked its chain-of-thought', () => {
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

  // A COMPLETED turn is never a candidate — even one carrying a `thought` marker.
  // This is the deliberate safety guarantee: a finished answer can never be blanked.
  it('does NOT suppress a `thought` preamble on a completed tool-call turn (finish_reason=tool_calls)', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'tool_calls' })).toBe(false);
  });

  it('does NOT suppress on a naturally-stopped turn even with a leak-shaped body', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'stop' })).toBe(false);
  });

  it('does NOT suppress a capitalized "Thought" heading on a truncated turn', () => {
    expect(isReasoningLeak({ ...base, content: 'Thought\nA legitimate reflection that got cut off' })).toBe(false);
  });
});
