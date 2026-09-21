import { AgentModeService } from '../services/agentModeService';

// Regression test for a live failure (2026-08-25, ENG-1580): Gemini correctly
// named materialize_knowledge_base_asset and attempted to unlock it via
// install_skills(['__other_skills__']), but that installation was rejected by
// the caller's subscription tier — so the tool, though registered, was never
// actually reachable. Its siblings list_knowledge_base_files /
// read_knowledge_base_files are foundation tools for exactly this reason
// (ENG-152/ENG-260 class of bug); this tool needs the same treatment.
describe('materialize_knowledge_base_asset foundation access', () => {
  it('is a foundation tool, reachable on every subscription tier like its KB siblings', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('materialize_knowledge_base_asset');
  });

  it('sits alongside its read/list siblings, not gated behind __other_skills__', () => {
    const tools = AgentModeService.DEFAULT_FOUNDATION_TOOLS;
    expect(tools).toContain('list_knowledge_base_files');
    expect(tools).toContain('read_knowledge_base_files');
    expect(tools).toContain('materialize_knowledge_base_asset');
  });
});
