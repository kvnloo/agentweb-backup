/**
 * Unit tests for the PURE "did this run actually answer?" predicate (ENG-946).
 *
 * A scheduled run is only complete when the transcript contains a real final
 * assistant answer — an assistant message carrying text that is NOT just the
 * narration attached to a tool-call turn. Prod scheduled runs were being recorded
 * as `success` while their transcripts ended on tool results, because the old
 * check only asked "is there ANY assistant message?" and a tool-call turn (which
 * often carries a one-line "I'll pull both datasets in parallel." narration)
 * satisfied it.
 */

import { transcriptHasFinalAssistantAnswer } from '../finalAnswer';

const sys = { role: 'system', content: 'You are EMMA.' };
const user = { role: 'user', content: 'Run the daily report.' };
const narrationTurn = {
  role: 'assistant',
  content: "I'll pull both datasets in parallel.",
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_all_clients', arguments: '{}' } }],
};
const toolResult = { role: 'tool', name: 'list_all_clients', tool_call_id: 'c1', content: '{"success":true}' };

describe('transcriptHasFinalAssistantAnswer', () => {
  it('accepts a transcript that ends on a real assistant answer', () => {
    expect(
      transcriptHasFinalAssistantAnswer([
        sys,
        user,
        narrationTurn,
        toolResult,
        { role: 'assistant', content: 'Here is the daily report: ...' },
      ]),
    ).toBe(true);
  });

  it('rejects a transcript that ends on tool results after tool-call narration', () => {
    // Prod shape: 9 assistant tool-call turns, 40 tool results, no synthesis.
    expect(transcriptHasFinalAssistantAnswer([sys, user, narrationTurn, toolResult])).toBe(false);
  });

  it('rejects a final assistant turn that came back with no text at all', () => {
    expect(
      transcriptHasFinalAssistantAnswer([sys, user, narrationTurn, toolResult, { role: 'assistant', content: '' }]),
    ).toBe(false);
  });

  it('rejects a final turn that is only the degraded cross-provider history placeholder', () => {
    expect(
      transcriptHasFinalAssistantAnswer([
        sys,
        user,
        narrationTurn,
        toolResult,
        { role: 'assistant', content: '[Previously called twitter_outreach({"action":"search_tweets"})]' },
      ]),
    ).toBe(false);
  });

  it('rejects whitespace-only assistant text', () => {
    expect(
      transcriptHasFinalAssistantAnswer([sys, user, narrationTurn, toolResult, { role: 'assistant', content: '  \n ' }]),
    ).toBe(false);
  });

  it('accepts Claude-style array content blocks', () => {
    expect(
      transcriptHasFinalAssistantAnswer([
        sys,
        user,
        narrationTurn,
        toolResult,
        { role: 'assistant', content: [{ type: 'text', text: 'Here is the report.' }] },
      ]),
    ).toBe(true);
  });

  it('accepts an answer emitted before later tool work (the answer need not be last)', () => {
    expect(
      transcriptHasFinalAssistantAnswer([
        sys,
        user,
        { role: 'assistant', content: 'Here is what I found so far.' },
        narrationTurn,
        toolResult,
      ]),
    ).toBe(true);
  });

  it('is inconclusive-safe: an empty or non-array transcript is not treated as answered', () => {
    expect(transcriptHasFinalAssistantAnswer([])).toBe(false);
    expect(transcriptHasFinalAssistantAnswer(undefined as any)).toBe(false);
  });

  it('ignores non-assistant roles carrying text', () => {
    expect(transcriptHasFinalAssistantAnswer([sys, user, toolResult])).toBe(false);
  });
});
