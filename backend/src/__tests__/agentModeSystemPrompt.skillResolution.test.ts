import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

describe('AgentMode system prompt - skill resolution policy', () => {
  it('requires resolve_skill before managing named skills or engines', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('call `resolve_skill` first');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never claim a skill does not exist unless `resolve_skill` returned no matches');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never call `manage_skill` update/delete/get with only a name');
  });

  it('contains guidelines for website scan', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('website scan');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Browser Automation');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('distinct from the SEO/GEO tools');
  });

  it('routes "Google Drive" phrasing to the real Drive tools, not the knowledge-base tools', () => {
    // Regression guard for a bug where Emma repeatedly called list_knowledge_base_files /
    // search_knowledge_base for "in my Google Drive" requests, and claimed zero folders
    // connected without ever calling a Drive tool — there was no routing entry at all.
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('"Google Drive"');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('**google_drive**');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do NOT claim "no Drive folders connected" without having called google_drive first');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('NOT the same as the knowledge-base\'s kb_type="google-drive" filter');
  });
});
