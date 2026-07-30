/**
 * Unit tests for the PURE Gemini reasoning-leak detector (ENG-737).
 *
 * The shapes below mirror the production session d103071a-…-f118f50eb366:
 * gemini-3.5-flash truncated its answer mid-reasoning and the OpenAI-compat
 * endpoint returned the raw chain-of-thought (a lowercase `thought` marker + a
 * degenerate loop of repeated search queries) as the assistant content, which
 * leaked into the chat. No real customer data is embedded here.
 *
 * The detector is deliberately conservative: it fires ONLY on a TRUNCATED
 * (finish_reason='length') Gemini turn, so a COMPLETED answer is never blanked.
 */

import {
  isReasoningLeak,
  looksLikeLeakedReasoning,
  hasLeadingThoughtMarker,
  hasDegenerateRepeatedLine,
  type LeakedReasoningInput,
} from '../reasoningLeak';

// A leaked `thought` monologue prefixed to a COMPLETED tool call (session 97d37f59,
// finish_reason='tool_calls'). The detector deliberately does NOT suppress this — a
// finished turn is never blanked, even with a thought marker — to guarantee a real
// answer is never erased.
const LEAKED_TOOL_PREAMBLE =
  "thought\nAh, let's read the content of `tool-responses/abc.txt` to find the article.\n" +
  "Wait, let's use `read_tool_response` on `tool-responses/abc.txt` which is small enough.";

// A degenerate reasoning loop: the same query line repeated back-to-back.
const REPEATED_QUERY =
  'Wait, let\'s search for "Some Person" "Some Org" or "Alt Org" on Google or other search engines.';
const LEAKED_THOUGHT_LOOP =
  'thought\nWait, the search results are looping. Let\'s look at what we found.\n' +
  Array(12).fill(REPEATED_QUERY).join('\n');

// The continuation fragment (no leading `thought` marker, still a repeated loop).
const LEAKED_CONTINUATION =
  '\n*   Wait, let\'s look at the search results we got:\n' +
  Array(12).fill('    - ' + REPEATED_QUERY).join('\n');

const CLEAN_ANSWER =
  "\nI've gathered the public background information you asked for.\n\n" +
  '<h3>1. Professional Profile</h3>\n<ul><li><strong>Specialty:</strong> Anesthesiology</li></ul>';

const base: LeakedReasoningInput = {
  finishReason: 'length',
  content: LEAKED_THOUGHT_LOOP,
  hasThoughtSignature: true,
  model: 'gemini-3.5-flash',
};

describe('hasDegenerateRepeatedLine', () => {
  it('detects a long line repeated 6+ times consecutively', () => {
    expect(hasDegenerateRepeatedLine(Array(6).fill(REPEATED_QUERY).join('\n'))).toBe(true);
  });

  it('does not fire on 5 repeats (below the conservative threshold)', () => {
    // Legit content may intentionally repeat an identical line a handful of times
    // (template / data / code rows); the real leak repeats 10-12×.
    expect(hasDegenerateRepeatedLine(Array(5).fill(REPEATED_QUERY).join('\n'))).toBe(false);
  });

  it('ignores short/trivial repeated lines (e.g. list bullets, rules)', () => {
    expect(hasDegenerateRepeatedLine('---\n---\n---\n---\n---\n---\n---')).toBe(false);
    expect(hasDegenerateRepeatedLine('\n\n\n\n\n\n\n')).toBe(false);
  });

  it('does not treat non-adjacent duplicates separated by other content as a loop', () => {
    const spaced = [REPEATED_QUERY, 'some other unique line here', REPEATED_QUERY, 'and another one entirely']
      .join('\n');
    expect(hasDegenerateRepeatedLine(spaced)).toBe(false);
  });
});

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

describe('looksLikeLeakedReasoning', () => {
  it('fires on a leading bare lowercase "thought" marker line', () => {
    expect(looksLikeLeakedReasoning('thought\nLet me reconsider the plan.')).toBe(true);
  });

  it('fires on a degenerate repeated-query continuation fragment', () => {
    expect(looksLikeLeakedReasoning(LEAKED_CONTINUATION)).toBe(true);
  });

  it('does NOT fire on a normal answer that merely starts with the word "Thought"', () => {
    expect(looksLikeLeakedReasoning('Thought leadership is a great content strategy.')).toBe(false);
  });

  it('does NOT fire on a clean synthesized answer', () => {
    expect(looksLikeLeakedReasoning(CLEAN_ANSWER)).toBe(false);
  });

  it('returns false on empty content', () => {
    expect(looksLikeLeakedReasoning('')).toBe(false);
  });
});

describe('isReasoningLeak', () => {
  it('suppresses a truncated gemini thinking turn that leaked its chain-of-thought', () => {
    expect(isReasoningLeak(base)).toBe(true);
  });

  it('suppresses a truncated continuation fragment (no marker, still looping)', () => {
    expect(isReasoningLeak({ ...base, content: LEAKED_CONTINUATION })).toBe(true);
  });

  it('does NOT suppress the final, non-truncated answer turn (finish_reason=stop)', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'stop', content: CLEAN_ANSWER })).toBe(false);
  });

  it('does NOT suppress a normal truncated answer fragment (no reasoning signature)', () => {
    expect(
      isReasoningLeak({
        ...base,
        content: 'Here is the first half of a long, legitimate answer that ran out of tokens',
      }),
    ).toBe(false);
  });

  it('does NOT touch non-gemini providers, even when truncated with a reasoning-shaped body', () => {
    expect(
      isReasoningLeak({
        finishReason: 'length',
        content: LEAKED_THOUGHT_LOOP,
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
  // (Cost: the rarer completed-tool-call-preamble leak shape, session 97d37f59, is
  // not caught. Accepted, because guaranteeing a real answer is never erased wins.)
  it('does NOT suppress a `thought` preamble on a completed tool-call turn (finish_reason=tool_calls)', () => {
    expect(
      isReasoningLeak({
        finishReason: 'tool_calls',
        content: LEAKED_TOOL_PREAMBLE,
        hasThoughtSignature: false,
        model: 'gemini-3.5-flash',
      }),
    ).toBe(false);
  });

  it('does NOT suppress on a naturally-stopped turn even with a leak-shaped body', () => {
    expect(isReasoningLeak({ ...base, finishReason: 'stop' })).toBe(false);
  });

  it('does NOT suppress a degenerate repeated-line loop when the turn completed (finish_reason=stop)', () => {
    expect(
      isReasoningLeak({ ...base, finishReason: 'stop', content: LEAKED_CONTINUATION }),
    ).toBe(false);
  });
});
