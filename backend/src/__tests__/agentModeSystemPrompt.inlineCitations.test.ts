import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-351: Emma must cite the source of every quoted number derived from research or
// measurement tasks INLINE, directly next to the figure it supports (matching the
// Claude/Gemini inline-citation style) — never aggregated only at the bottom or omitted.
describe('Agent Mode system prompt — inline source citations for quoted numbers', () => {
  it('has a dedicated inline source citations section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Inline Source Citations');
  });

  it('requires the source to sit inline, immediately next to the quoted number', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('immediately next to the number it supports');
    // Must NOT be aggregated only in a bottom references section.
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Do NOT aggregate all sources only in a separate references section');
  });

  it('references the Claude and Gemini inline-citation benchmark style', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Claude and Gemini');
  });

  it('scopes the rule to research and measurement outputs', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('deep research reports');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('benchmark comparisons');
  });

  it('forbids fabricating citations (ties into truthful reporting)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never invent a citation');
  });
});
