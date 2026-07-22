import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-289: Emma must reliably surface the canonical Linear link (clickable) to admins /
// delegated-admin sessions, but never invent one for reporters whose result lacks canonicalUrl.
describe('Agent Mode system prompt — report_product_issues canonical link guidance', () => {
  it('instructs Emma to share canonicalUrl as a clickable Linear link when present', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('canonicalUrl');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('clickable Linear link');
  });

  it('scopes it to admins/delegated and forbids inventing a link when absent', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('only for admins and delegated-admin sessions');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never invent or infer a Linear link when it is absent');
  });
});
