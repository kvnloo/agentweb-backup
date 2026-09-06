import { computeSessionModelAttribution } from '../sessionModelAttribution';

describe('computeSessionModelAttribution', () => {
  it('returns all-null when there are no messages and no picker model', () => {
    const result = computeSessionModelAttribution([], null);
    expect(result).toEqual({
      generationModels: null,
      attributedModels: null,
      attributionBasis: null,
      modelLine: null,
    });
  });

  it('falls back to selection-only when no assistant turn recorded a model', () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant' }, // no llm field
    ];
    const result = computeSessionModelAttribution(messages, 'gemini-3.7-flash');
    expect(result.generationModels).toBeNull();
    expect(result.attributedModels).toEqual(['gemini-3.7-flash']);
    expect(result.attributionBasis).toBe('selection-only');
    expect(result.modelLine).toBe('gemini-3.7-flash');
  });

  it('reports transcript basis and collapses modelLine when every turn agrees with the picker', () => {
    const messages = [
      { role: 'assistant', llm: 'gemini-3.7-flash' },
      { role: 'assistant', llm: 'gemini-3.7-flash' },
    ];
    const result = computeSessionModelAttribution(messages, 'gemini-3.7-flash');
    expect(result.generationModels).toEqual(['gemini-3.7-flash']);
    expect(result.attributedModels).toEqual(['gemini-3.7-flash']);
    expect(result.attributionBasis).toBe('transcript');
    expect(result.modelLine).toBe('gemini-3.7-flash');
  });

  // ENG-426/ENG-1565 incident (session e6c9e693-…): the picker/policy snapshot
  // said gemini-3.7-flash "honored" for the whole session, but the transcript
  // shows the entire spiral actually ran on GLM — this is the exact case the
  // fix exists for.
  it('shows "picker: X · ran: Y" when a session ran on a different model than the picker reports — never silently agrees', () => {
    const messages = [
      { role: 'assistant', llm: 'openrouter/z-ai/glm-5.2' },
      { role: 'assistant', llm: 'openrouter/z-ai/glm-5.2' },
      { role: 'assistant', llm: 'gemini-3.7-flash' },
    ];
    const result = computeSessionModelAttribution(messages, 'gemini-3.7-flash');
    expect(result.generationModels).toEqual(['openrouter/z-ai/glm-5.2', 'gemini-3.7-flash']);
    expect(result.attributedModels).toEqual(['openrouter/z-ai/glm-5.2', 'gemini-3.7-flash']);
    expect(result.attributionBasis).toBe('transcript');
    expect(result.modelLine).toBe('picker: gemini-3.7-flash · ran: openrouter/z-ai/glm-5.2, gemini-3.7-flash');
  });

  it('treats the picker being one of several models that ran as NOT agreement — still shows both', () => {
    // A picker-plus-backup run: the picker DID run, but so did another model.
    // Agreement means the picker is the WHOLE story, not merely present.
    const messages = [
      { role: 'assistant', llm: 'gemini-3.7-flash' },
      { role: 'assistant', llm: 'openrouter/z-ai/glm-5.2' },
    ];
    const result = computeSessionModelAttribution(messages, 'gemini-3.7-flash');
    expect(result.modelLine).toBe('picker: gemini-3.7-flash · ran: gemini-3.7-flash, openrouter/z-ai/glm-5.2');
  });

  it('marks partial-transcript and appends the unlabelled-turns qualifier when only some turns recorded a model', () => {
    const messages = [
      { role: 'assistant', llm: 'openrouter/z-ai/glm-5.2' },
      { role: 'assistant' }, // unlabelled
      { role: 'assistant', llm: 'openrouter/z-ai/glm-5.2' },
    ];
    const result = computeSessionModelAttribution(messages, 'openrouter/z-ai/glm-5.2');
    expect(result.attributionBasis).toBe('partial-transcript');
    expect(result.modelLine).toBe('openrouter/z-ai/glm-5.2 (partial — 1 of 3 assistant turns unlabelled)');
  });

  it('ignores non-assistant messages entirely', () => {
    const messages = [
      { role: 'user', llm: 'should-be-ignored' },
      { role: 'tool', llm: 'should-be-ignored-too' },
      { role: 'assistant', llm: 'gemini-3.7-flash' },
    ];
    const result = computeSessionModelAttribution(messages, 'gemini-3.7-flash');
    expect(result.generationModels).toEqual(['gemini-3.7-flash']);
  });

  it('handles undefined/null messages input without throwing', () => {
    expect(computeSessionModelAttribution(undefined, 'gemini-3.7-flash').attributionBasis).toBe('selection-only');
    expect(computeSessionModelAttribution(null, null).attributionBasis).toBeNull();
  });
});
