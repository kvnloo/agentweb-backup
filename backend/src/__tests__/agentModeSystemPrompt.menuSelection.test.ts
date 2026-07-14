import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-191: Agent presented a numbered menu (1: specific client, 2: platform-wide,
// 3: workspace activity), the user replied "1", and the agent proceeded with option 2
// (platform-wide) — ignoring the explicit selection and skipping the follow-up the
// chosen branch required (asking for the client name/email). The system prompt must
// tell Emma to map the numeric reply back to the option it presented, echo it, execute
// exactly that branch, and collect that branch's prerequisites before generating.
describe('AgentMode system prompt - numbered menu selection guard', () => {
  it('has a dedicated menu / numbered choice guard', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Menu Selection Guard');
  });

  it('requires mapping the numeric reply back to the presented option and echoing it', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Map that number back to the exact option you listed');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Echo the mapped choice');
  });

  it('requires executing exactly the chosen branch and collecting its prerequisites first', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Execute exactly that branch');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('collect any inputs that branch requires');
  });

  it('includes a self-check that the executed branch matches the stated selection', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('matches the number the user actually chose');
  });
});
