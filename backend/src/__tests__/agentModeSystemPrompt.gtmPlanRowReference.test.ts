import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

/**
 * ENG-1492: the "GTM plan" Page & Feature Tool Reference row only mapped to
 * list_gtm_plans/read_gtm_plan, never cross-referencing create_gtm_plan
 * (defined separately in the "GTM Plan Capabilities" section) -- so the
 * "GTM plan"/"go-to-market" keyword shortcut had no path to plan creation.
 * Pins that the row now covers both read and create.
 */
describe('AgentMode system prompt - GTM plan row references create_gtm_plan (ENG-1492)', () => {
  it('keeps the existing read-path tools for the GTM plan row', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      '"GTM plan", "go-to-market", "launch plan", "GTM page" → **list_gtm_plans**, **read_gtm_plan**'
    );
  });

  it('now also routes to create_gtm_plan for creating a new plan', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('**create_gtm_plan**');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'To CREATE a new GTM plan (e.g. "I want a go-to-market plan", "build me a launch plan") → **create_gtm_plan**.'
    );
  });
});
