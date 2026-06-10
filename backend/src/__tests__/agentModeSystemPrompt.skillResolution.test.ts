import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

describe('AgentMode system prompt - skill resolution policy', () => {
  it('requires resolve_skill before managing named skills or engines', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('call `resolve_skill` first');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never claim a skill does not exist unless `resolve_skill` returned no matches');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never call `manage_skill` update/delete/get with only a name');
  });
});
