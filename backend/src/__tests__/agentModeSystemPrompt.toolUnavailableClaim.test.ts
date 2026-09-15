import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

/**
 * ENG-1945 follow-up — the same-batch install_skills race (the ticket's stated
 * fix) was NOT what produced the reported incident. The prod transcript
 * (session ff31ccb7) shows the agent never called playwright_browser_navigate/
 * snapshot/evaluate/click even once before filing a bug via
 * report_product_issues claiming they were "unavailable" — it inferred that
 * from an unrelated playwright_browser_handle_dialog "no modal state present"
 * error, then proved itself wrong on the very next real attempt (which
 * succeeded immediately). That is a truthful-reporting gap, not a tool-gating
 * bug: nothing told the model a claim of unavailability requires having
 * actually attempted the call.
 *
 * This pins the unconditional (applies to every session, attended or not —
 * unlike the ENG-803 scheduled-only gate rule) rule closing that gap.
 */
describe('Agent Mode system prompt — no tool-unavailable claim without an actual attempt (ENG-1945 follow-up)', () => {
  it('bans claiming a tool/capability is broken or unavailable without having called it in this session', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Never claim a tool or capability is broken, unavailable, or "not working"',
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('report_product_issues');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'unless you actually called that exact tool in THIS session and it errored or returned a failure',
    );
  });

  it('names the exact failure mode observed in the prod incident: inferring from an unrelated error or not having tried', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain("a DIFFERENT tool's error");
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('simply from not having tried it yet');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do not report a guess as a finding');
  });

  it('requires the real failure to be scoped to the specific tool, not generalized into "tools are unavailable"', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('name the SPECIFIC tool and quote the verbatim error');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do not generalize it into "tools are unavailable"');
  });

  it('reinforces the rule at the report_product_issues bug-filing call site itself', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'you must have actually called that tool in THIS session and gotten the failure',
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Do NOT file "tool X is unavailable" from an inference');
  });

  it('lives in the UNCONDITIONAL Truthful Reporting section, not a session-type-gated override', () => {
    // Unlike getScheduledSessionOverride's ENG-803 gate rule (scheduled runs only),
    // this must apply to every session — the ENG-1945 incident was an ATTENDED
    // delegated-admin session, not a scheduled/unattended run.
    const criticalSectionIndex = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Truthful Reporting (CRITICAL)');
    const ruleIndex = AGENT_MODE_SYSTEM_PROMPT.indexOf(
      'Never claim a tool or capability is broken, unavailable, or "not working"',
    );
    const nextSectionIndex = AGENT_MODE_SYSTEM_PROMPT.indexOf('## Analytics & Tracking Claims (CRITICAL)');
    expect(criticalSectionIndex).toBeGreaterThan(-1);
    expect(ruleIndex).toBeGreaterThan(criticalSectionIndex);
    expect(ruleIndex).toBeLessThan(nextSectionIndex);
  });
});

/**
 * ENG-1945 second follow-up — the prompt-only rule above cannot GUARANTEE
 * compliance, only instruct it. `claimed_unavailable_tools` (report_product_issues'
 * schema, emma/tools.ts) is the deterministic backstop: the server checks it
 * against the run's own EVT_TOOL_INVOKED telemetry and rejects an unverified
 * claim, independent of anything the model writes. That backstop only engages
 * if the model actually populates the field, so the prompt must point at it
 * explicitly wherever it tells the model to make an unavailability claim.
 */
describe('Agent Mode system prompt — points the model at the deterministic claimed_unavailable_tools gate', () => {
  it('tells the model to set claimed_unavailable_tools + run_id instead of only describing it in prose', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('ALWAYS set `claimed_unavailable_tools`');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do not only describe it in prose');
  });

  it('accurately describes what the server does: REJECTS the structured claim, but a prose-only claim still files', () => {
    // This must stay truthful about the tool's actual behavior — claiming the server
    // rejects EVERY unavailability claim (including prose-only ones) would itself be
    // exactly the kind of overclaim this whole rule exists to ban.
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('REJECTS the filing');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('does NOT go through this check and will still file');
  });

  it('reinforces the field at the report_product_issues bug-filing call site', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Set `claimed_unavailable_tools: ["X"]` and `run_id`');
  });
});
