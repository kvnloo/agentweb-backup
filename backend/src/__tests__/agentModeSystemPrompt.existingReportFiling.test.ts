import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-1951: a user asked Emma to file an ALREADY-GENERATED HTML report (given by URL)
// into the Research Reports tab without regenerating it. No tool exists for "register
// an existing report" — every content tool (create_html_file, save_file,
// create_html_from_template) regenerates content from scratch. Primed by the
// "Foundation Tools vs Skill Tools" section ("the tool is almost certainly inside an
// Available Skill — install it"), Emma looked for a nonexistent skill/tool, found none,
// and filed a false report_product_issues ticket telling the user it was blocked —
// even though mentioning the report URL in the conversation is already enough for it
// to be auto-detected and listed under Research Reports (scanMessagesForAssets).
describe('Agent Mode system prompt — filing an existing report (do not regenerate)', () => {
  it('has a dedicated section for filing an existing report URL', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Filing an Existing Report');
  });

  it('forbids regenerating the report with content-creation tools', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do NOT call `create_html_file`, `save_file`, or `create_html_from_template`');
  });

  it('tells Emma not to go looking for a nonexistent registration tool/skill', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('installing more skills will not surface one');
  });

  it('explains the report URL is auto-detected and filed with no tool call needed', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('automatically detected and added to the Research Reports tab');
  });

  it('forbids filing a false product-issue report for this working capability', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do NOT call `report_product_issues` for this');
  });
});
