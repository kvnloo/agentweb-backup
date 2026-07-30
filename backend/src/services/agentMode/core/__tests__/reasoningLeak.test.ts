/**
 * Unit tests for the PURE Gemini reasoning-leak detector (ENG-737).
 *
 * The shapes below mirror the production session d103071a-…-f118f50eb366:
 * gemini-3.5-flash truncated its answer mid-reasoning and the OpenAI-compat
 * endpoint returned the raw chain-of-thought (a leading `thought` marker + a
 * degenerate loop of repeated search queries) as the assistant content, which
 * leaked into the chat. No real customer data is embedded here.
 */

import {
  isTruncatedReasoningLeak,
  looksLikeLeakedReasoning,
  hasDegenerateRepeatedLine,
  type LeakedReasoningInput,
} from '../reasoningLeak';

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
  it('detects a long line repeated 4+ times consecutively', () => {
    expect(hasDegenerateRepeatedLine(Array(4).fill(REPEATED_QUERY).join('\n'))).toBe(true);
  });

  it('does not fire on 3 repeats (below threshold)', () => {
    expect(hasDegenerateRepeatedLine(Array(3).fill(REPEATED_QUERY).join('\n'))).toBe(false);
  });

  it('ignores short/trivial repeated lines (e.g. list bullets, rules)', () => {
    expect(hasDegenerateRepeatedLine('---\n---\n---\n---\n---')).toBe(false);
    expect(hasDegenerateRepeatedLine('\n\n\n\n\n')).toBe(false);
  });

  it('does not treat non-adjacent duplicates separated by other content as a loop', () => {
    const spaced = [REPEATED_QUERY, 'some other unique line here', REPEATED_QUERY, 'and another one entirely']
      .join('\n');
    expect(hasDegenerateRepeatedLine(spaced)).toBe(false);
  });
});

describe('looksLikeLeakedReasoning', () => {
  it('fires on a leading bare "thought" marker line', () => {
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

describe('isTruncatedReasoningLeak', () => {
  it('suppresses a truncated gemini thinking turn that leaked its chain-of-thought', () => {
    expect(isTruncatedReasoningLeak(base)).toBe(true);
  });

  it('suppresses a truncated continuation fragment (no marker, still looping)', () => {
    expect(isTruncatedReasoningLeak({ ...base, content: LEAKED_CONTINUATION })).toBe(true);
  });

  it('does NOT suppress the final, non-truncated answer turn (finish_reason=stop)', () => {
    expect(isTruncatedReasoningLeak({ ...base, finishReason: 'stop', content: CLEAN_ANSWER })).toBe(false);
  });

  it('does NOT suppress a normal truncated answer fragment (no reasoning signature)', () => {
    expect(
      isTruncatedReasoningLeak({
        ...base,
        content: 'Here is the first half of a long, legitimate answer that ran out of tokens',
      }),
    ).toBe(false);
  });

  it('does NOT touch non-gemini providers, even when truncated with a reasoning-shaped body', () => {
    expect(
      isTruncatedReasoningLeak({
        finishReason: 'length',
        content: LEAKED_THOUGHT_LOOP,
        hasThoughtSignature: false,
        model: 'anthropic.claude-opus-4-8',
      }),
    ).toBe(false);
  });

  it('fires for a gemini-* model even without a thought_signature present', () => {
    expect(
      isTruncatedReasoningLeak({ ...base, hasThoughtSignature: false, model: 'gemini-3.5-flash' }),
    ).toBe(true);
  });
});
