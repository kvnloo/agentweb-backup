import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

/**
 * ENG-1490: live DynamoDB trace (production sessionId
 * b71af8c0-afab-4cff-8417-d5148b05d286) proved Emma calls
 * list_predefined_work_plans, finds a clearly matching plan, and STILL drafts
 * content directly via create_social_media_posts instead of calling
 * recommend_predefined_work_plan. Root cause: two CRITICAL, apply-to-every-
 * request policies ("Follow Explicit Direction", "When to Ask Questions")
 * appear much earlier in the prompt than Work Plan Capabilities and
 * explicitly tell the model to skip confirmation and just produce a draft —
 * "producing a draft" is named as exempt from confirmation. The Work Plan
 * Capabilities check was never wired into those policies or into the
 * Decision Framework's EXECUTE step, so it lost.
 *
 * These assertions pin the four places that now make the recommendation an
 * explicit substitute for drafting, not an extra step alongside it.
 */
describe('AgentMode system prompt - recommend-workplan gate vs draft-without-asking policy (ENG-1490)', () => {
  it('wires the work-plan check into the Decision Framework EXECUTE step', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'run the Work Plan Capabilities check below FIRST, before drafting or otherwise producing the deliverable yourself'
    );
  });

  it('carves out the work-plan-match case from the "producing a draft never needs confirmation" rule', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      '**Exception — a matching work plan beats an ad-hoc draft.**'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'propose the plan via **recommend_predefined_work_plan** INSTEAD of drafting the content yourself'
    );
  });

  it('states the recommendation replaces drafting in the canonical Work Plan Capabilities paragraph', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'This recommendation replaces drafting the content yourself in that turn — it is not an extra step you do in addition to drafting'
    );
  });

  it('rewords the LinkedIn row to "instead of" framing rather than "before drafting"', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'propose it via **recommend_predefined_work_plan** INSTEAD of calling **create_social_media_posts** in this same turn'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toContain('before drafting content directly.');
  });

  it('leaves the spend/publish/irreversible confirmation floor and the Slack-approval exception unchanged', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Explicit confirmation is required ONLY for three things: spend changes (budgets, campaign launches/pauses, ad-account writes), publish/send actions'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'ALWAYS** show the user the draft Slack message and ask for explicit approval BEFORE calling `slack_send_message`'
    );
  });
});
