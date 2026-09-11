import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1855: when publish_landing_page_changes is unreachable (e.g. install_skills refusing
// the bundle it lives in), Emma told a real customer "In the AgentWeb app, navigate to
// Landing Pages, open this page, and click Publish." Checked the actual customer-portal
// source directly — no code path anywhere in the UI calls the publish route for this flow.
// There is no Publish button. Emma invented it entirely on her own: nothing in this prompt,
// right or wrong, said anything about a manual UI path — the fix is to add the missing
// guidance, not correct existing guidance, since none existed.
describe('AgentMode system prompt - no fabricated manual Publish UI', () => {
  it('states publish_landing_page_changes is the ONLY way to make edits live', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'publish_landing_page_changes** is the ONLY way to make edits live'
    );
  });

  it('explicitly forbids sending the user to find a manual Publish button', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'do NOT tell them to find a manual "Publish" button anywhere in the AgentWeb app'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('No such control exists anywhere in the product');
  });

  it('tells Emma what to say instead when publish is unreachable', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'tell the user publishing is temporarily unavailable and to check back or retry'
    );
  });
});
