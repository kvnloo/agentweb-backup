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

  // ── ENG-657: final-turn synthesis guard keyed off THIS turn's text ──────────
  // The loop's `content` is replace-on-nonempty, so a run that narrates mid-tool
  // ("Now enriching list 5…") and then ends its FINAL turn with NO text leaves
  // that stale narration in `content`. The global `!content` check then wrongly
  // sees "content" and skips the synthesis retry, so the run finishes with no
  // final deliverable. When the caller passes `currentTurnText` (this turn's own
  // text), the empty-synthesis retry keys off it instead.
  describe('currentTurnText final-turn synthesis guard (ENG-657)', () => {
    it('synthesis-retries when THIS turn produced no text even though stale narration remains in content', () => {
      const d = decideTermination({
        ...base,
        content: 'Now enriching list 5 of 5…', // stale narration from an earlier tool turn
        currentTurnText: '', // the terminating turn emitted no synthesis
        toolCallsSoFar: 10,
        emptySynthesisRetries: 0,
        maxEmptySynthesisRetries: 1,
      });
      expect(d.shouldContinue).toBe(true);
      expect(d.reason).toBe('empty_synthesis_retry');
      expect(d.injectMessage).toContain('synthesize');
    });

    it('does NOT retry when THIS turn actually delivered the final report', () => {
      const d = decideTermination({
        ...base,
        content: 'Now enriching list 5 of 5…',
        currentTurnText: 'Here are the 10 recommended leads and 2 drafted follow-ups…',
        toolCallsSoFar: 10,
        emptySynthesisRetries: 0,
        maxEmptySynthesisRetries: 1,
      });
      expect(d.shouldContinue).toBe(false);
      expect(d.reason).toBe('final_response');
    });

    it('respects the retry budget on the stale-narration case', () => {
      const d = decideTermination({
        ...base,
        content: 'Now enriching list 5 of 5…',
        currentTurnText: '',
        toolCallsSoFar: 10,
        emptySynthesisRetries: 1,
        maxEmptySynthesisRetries: 1,
      });
      expect(d.shouldContinue).toBe(false);
      expect(d.reason).toBe('final_response');
    });

    it('does NOT retry the stale-narration case when a content filter fired (safety stop wins)', () => {
      const d = decideTermination({
        ...base,
        finishReason: 'content_filter',
        content: 'Now enriching list 5 of 5…',
        currentTurnText: '',
        toolCallsSoFar: 10,
        emptySynthesisRetries: 0,
        maxEmptySynthesisRetries: 1,
      });
      expect(d.shouldContinue).toBe(false);
      expect(d.reason).toBe('content_filtered');
    });

    it('is back-compat: with currentTurnText undefined it still keys off content', () => {
      // Non-empty content, no currentTurnText → no retry (unchanged behavior).
      expect(
        decideTermination({ ...base, content: 'stale', toolCallsSoFar: 5 }).reason
      ).toBe('final_response');
      // Empty content, no currentTurnText → retry (unchanged behavior).
      expect(
        decideTermination({ ...base, content: '', toolCallsSoFar: 5 }).reason
      ).toBe('empty_synthesis_retry');
    });
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
