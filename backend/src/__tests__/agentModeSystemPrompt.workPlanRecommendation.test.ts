import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

/**
 * ENG-1477: ENG-1472 already taught the prompt WHICH tool to call once a
 * goal-matching predefined plan is known (`recommend_predefined_work_plan`),
 * but the branching logic assumed the model already has the plan list in
 * hand ("matches exactly one template from list_predefined_work_plans") —
 * it never told Emma to actually CALL list_predefined_work_plans first when
 * the user hasn't asked about work plans at all. `list_predefined_work_plans`
 * results are not auto-injected into context the way the *active* plan's
 * status is (see the "automatically provided in your context" line just
 * below this section) — nothing made discovering the list an anticipated
 * step for an ordinary goal statement.
 *
 * Live-tested reproduction (Harsha, 2026-08-22): saying "I'm interested in
 * making some linkedin posts" in a fresh chat never triggered a
 * recommendation, even though a matching predefined plan existed. Emma had
 * no accessible-plans list in context and nothing telling her to go fetch
 * one for an unprompted goal statement, so the match-check the prompt
 * describes never actually ran.
 */
describe('AgentMode system prompt - proactive work plan recommendation lookup (ENG-1477)', () => {
  it('instructs calling list_predefined_work_plans proactively for an unprompted goal statement, not just describing the match once the list is already known', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'check for a match before replying: if you have not already called **list_predefined_work_plans** this session, call it now, even though the user never asked about work plans'
    );
  });

  it('keeps the example phrasing anchored to the actual reported repro case', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('"I\'m interested in making some LinkedIn posts"');
  });

  it('still requires recommend_predefined_work_plan (not launch) once a single match is found, unchanged from ENG-1472', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'call **recommend_predefined_work_plan** with that plan\'s id and a short one-sentence reason'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('do NOT call **launch_predefined_work_plan** in this case');
  });

  it('still asks ONE clarifying question on an ambiguous multi-plan match, unchanged from ENG-1472', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'If two or more accessible templates are plausibly applicable, ask the user ONE clarifying question instead of guessing which to recommend.'
    );
  });
});

/**
 * ENG-1974: "Keep chatting" on a recommendation card leaves no backend/model
 * signal that the user declined -- the recommendation's tool-call result
 * just sits in context forever, so an ordinary next message could get the
 * model to self-launch it via launch_predefined_work_plan (live-confirmed on
 * env1, twice). The dynamic per-turn note (built by
 * buildDeclinedWorkPlanRecommendationContextMessages) is the primary
 * signal; this static sentence is the cross-reference telling the model
 * that note exists and what to do about it, same convention as the
 * "automatically provided in your context" line for the active work plan.
 */
describe('AgentMode system prompt - declined work plan recommendation cross-reference (ENG-1974)', () => {
  it('tells the model not to launch a previously-declined plan on an ordinary message, and to wait for explicit confirmation', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'If a recommended plan was previously declined via "Keep chatting", you\'ll see a note above the user\'s message saying so'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'do not call **launch_predefined_work_plan** for it again on the strength of an ordinary on-topic message'
    );
  });
});
