/**
 * Unit tests for the PURE termination-decision module.
 *
 * These assert the decision ladder extracted from the monolith's "no tool_calls"
 * branch. They are implementation tests for the extracted module; the behavior-
 * preserving guarantee against the live loop is carried by the characterization
 * harness in src/__tests__/agentMode/characterization/.
 */

import { decideTermination, type TerminationInput } from '../termination';

const base: TerminationInput = {
  finishReason: 'stop',
  stopReason: undefined,
  content: 'Here is the answer.',
  toolCallsSoFar: 0,
  maxTokensContinuations: 0,
  maxTokenContinuationsLimit: 3,
  emptySynthesisRetries: 0,
  maxEmptySynthesisRetries: 1,
};

describe('decideTermination', () => {
  it('stops with final_response on a normal text turn', () => {
    const d = decideTermination(base);
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
    expect(d.injectMessage).toBeUndefined();
    expect(d.contentIfEmpty).toBeUndefined();
  });

  it('continues on finish_reason=length when under the continuation limit', () => {
    const d = decideTermination({ ...base, finishReason: 'length', content: '' });
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('max_tokens_continuation');
    expect(d.injectMessage).toContain('continue exactly where you left off');
    expect(d.counterDelta.maxTokensContinuations).toBe(1);
  });

  it('stops (does NOT continue) on finish_reason=length once the continuation limit is reached', () => {
    const d = decideTermination({
      ...base,
      finishReason: 'length',
      content: 'partial',
      maxTokensContinuations: 3,
      maxTokenContinuationsLimit: 3,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });

  it('continues with a synthesis nudge when content is empty and tools ran earlier', () => {
    const d = decideTermination({
      ...base,
      content: '',
      toolCallsSoFar: 2,
      emptySynthesisRetries: 0,
      maxEmptySynthesisRetries: 1,
    });
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('empty_synthesis_retry');
    expect(d.injectMessage).toContain('synthesize');
    expect(d.counterDelta.emptySynthesisRetries).toBe(1);
  });

  it('does NOT synthesis-retry when the retry budget is exhausted', () => {
    const d = decideTermination({
      ...base,
      content: '',
      toolCallsSoFar: 2,
      emptySynthesisRetries: 1,
      maxEmptySynthesisRetries: 1,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });

  it('does NOT synthesis-retry when no tools ran (empty first-turn response)', () => {
    const d = decideTermination({ ...base, content: '', toolCallsSoFar: 0 });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });

  describe('content filter', () => {
    it('adopts the canned safety message via contentIfEmpty when there is no content', () => {
      const d = decideTermination({
        ...base,
        finishReason: 'content_filter',
        content: '',
        toolCallsSoFar: 0,
      });
      expect(d.shouldContinue).toBe(false);
      expect(d.reason).toBe('content_filtered');
      expect(d.contentIfEmpty).toContain('content safety guidelines');
    });

    it('recognizes Claude stop_reason variants (guardrail_intervened, content_filtered)', () => {
      for (const stopReason of ['guardrail_intervened', 'content_filtered']) {
        const d = decideTermination({ ...base, stopReason, content: '', toolCallsSoFar: 0 });
        expect(d.reason).toBe('content_filtered');
        expect(d.contentIfEmpty).toContain('content safety guidelines');
      }
    });

    it('does NOT trigger a synthesis retry after a content filter (canned message counts as content)', () => {
      // Matches the monolith: the content-filter block sets `content` BEFORE the
      // empty-synthesis check runs, so the synthesis retry is suppressed.
      const d = decideTermination({
        ...base,
        finishReason: 'content_filter',
        content: '',
        toolCallsSoFar: 5, // tools ran, but filter already filled content
        emptySynthesisRetries: 0,
        maxEmptySynthesisRetries: 1,
      });
      expect(d.shouldContinue).toBe(false);
      expect(d.reason).toBe('content_filtered');
      expect(d.contentIfEmpty).toContain('content safety guidelines');
    });

    it('keeps existing content when a filter fires but content was already produced', () => {
      const d = decideTermination({
        ...base,
        finishReason: 'content_filter',
        content: 'already had this',
        toolCallsSoFar: 0,
      });
      expect(d.reason).toBe('content_filtered');
      expect(d.contentIfEmpty).toBeUndefined();
    });
  });
});

describe('decideTermination — ENG-946: the terminating turn owns the empty-synthesis decision', () => {
  // Prod signature (scheduled X Reply Guy runs): the model narrates mid-run
  // ("I'll scan his roster…"), runs tools, then its FINAL turn comes back with
  // zero text. The loop's accumulated `content` still holds the stale narration,
  // so the empty-synthesis nudge never fired and the run shipped the narration
  // as if it were the report.
  it('nudges when THIS turn produced no text, even though earlier narration is still accumulated', () => {
    const d = decideTermination({
      ...base,
      content: "I'll scan his roster and check what he's already engaged with today.",
      currentTurnText: '',
      toolCallsSoFar: 9,
      emptySynthesisRetries: 0,
      maxEmptySynthesisRetries: 1,
    });
    expect(d.shouldContinue).toBe(true);
    expect(d.reason).toBe('empty_synthesis_retry');
    expect(d.counterDelta.emptySynthesisRetries).toBe(1);
  });

  it('does NOT nudge when THIS turn produced real text (accumulated content irrelevant)', () => {
    const d = decideTermination({
      ...base,
      content: 'stale narration',
      currentTurnText: 'Here is the full report.',
      toolCallsSoFar: 9,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });

  it('still respects the retry budget when the terminating turn is empty', () => {
    const d = decideTermination({
      ...base,
      content: 'stale narration',
      currentTurnText: '',
      toolCallsSoFar: 9,
      emptySynthesisRetries: 1,
      maxEmptySynthesisRetries: 1,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });

  it('does not nudge on an empty terminating turn when no tools ever ran', () => {
    const d = decideTermination({
      ...base,
      content: 'stale narration',
      currentTurnText: '',
      toolCallsSoFar: 0,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });

  it('keeps the content-filter path free of synthesis retries even with an empty turn text', () => {
    const d = decideTermination({
      ...base,
      finishReason: 'content_filter',
      content: '',
      currentTurnText: '',
      toolCallsSoFar: 5,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('content_filtered');
    expect(d.contentIfEmpty).toContain('content safety guidelines');
  });

  it('omitting currentTurnText preserves the pre-fix behavior (accumulated content decides)', () => {
    const d = decideTermination({
      ...base,
      content: 'stale narration',
      toolCallsSoFar: 9,
    });
    expect(d.shouldContinue).toBe(false);
    expect(d.reason).toBe('final_response');
  });
});
