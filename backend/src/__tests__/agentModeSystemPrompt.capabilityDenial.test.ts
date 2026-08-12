import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1002 follow-up: a user asked Emma to search LinkedIn for people by title
// and location. Emma answered "there's genuinely no tool in my kit that queries
// LinkedIn's member directory", repeated it when challenged, fell back to a
// public web search, and four messages later installed a skill — proving the
// capability was one install_skills call away the whole time.
//
// The "Available Skills" list (skill id, description AND tool names) is already
// injected into every conversation, so this was never missing knowledge: the
// model denied a capability without consulting a list it already had. The guard
// therefore has to be behavioural — check before you deny — rather than another
// injection of the same facts.
describe('AgentMode system prompt - capability denial guard', () => {
  it('has a dedicated never-deny-unchecked section', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('NEVER deny a capability you have not checked');
  });

  it('frames an uninstalled skill as available rather than missing', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('An\nuninstalled skill is not a missing capability');
  });

  it('requires scanning Available Skills before telling the user it cannot be done', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('before you tell the user you cannot do something');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('list_available_skills');
  });

  it('bans the exact phrasings the reported session used', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain("I don't have a tool for that");
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain("there's no tool in my kit");
  });

  it('names LinkedIn people-search as supported, so the reported case cannot recur', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('LinkedIn people-search by title/company/location IS supported');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('import_leads_from_search');
  });

  it('tells the model to correct itself rather than stand by a wrong denial', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('correct yourself plainly');
  });
});
