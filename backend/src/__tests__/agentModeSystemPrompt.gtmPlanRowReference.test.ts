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
      'To CREATE a new GTM plan when the user is asking to view/manage what already exists → **create_gtm_plan**.'
    );
  });

  it('ENG-1492 follow-up: a GOAL-shaped GTM request checks predefined work plans first, matching the sibling-row pattern', () => {
    // real matching predefined system plans confirmed live: GTM_planning, GTM_discovery
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'check for a matching predefined work plan first per the Work Plan Capabilities section. If one clearly fits, propose it via **recommend_predefined_work_plan** INSTEAD of calling **create_gtm_plan** in this same turn'
    );
  });
});
