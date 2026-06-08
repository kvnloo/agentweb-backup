import { buildSmartFieldEvalSystemPrompt } from '../services/enrichmentPrompts';

describe('buildSmartFieldEvalSystemPrompt — instruction priority over null fallback', () => {
  it('treats the field condition as authoritative', () => {
    expect(buildSmartFieldEvalSystemPrompt().toLowerCase()).toContain('authoritative');
  });

  it('instructs the model to apply an explicit "else"/default instead of returning null', () => {
    const prompt = buildSmartFieldEvalSystemPrompt().toLowerCase();
    expect(prompt).toContain('else');
    expect(prompt).toMatch(/do not return null/);
  });

  it('only returns null when the condition provides no explicit default/else', () => {
    const prompt = buildSmartFieldEvalSystemPrompt().toLowerCase();
    expect(prompt).toMatch(/no explicit default/);
  });
});
