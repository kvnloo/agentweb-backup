import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

/**
 * ENG-1484: live-reproduced (Harsha, 2026-08-23) even AFTER ENG-1478 shipped
 * (which taught Emma to proactively call list_predefined_work_plans on an
 * unprompted goal statement) — saying "I'm interested in making some
 * linkedin posts" in a fresh chat still went straight to drafting 3 posts,
 * never checking for the accessible "Research Based Linkedin Founder Post"
 * predefined plan.
 *
 * Root cause: the "Page & Feature Tool Reference" table (a SEPARATE section
 * from Work Plan Capabilities) has an unconditional row —
 * "LinkedIn content", "LinkedIn posts", "LinkedIn page" → list_connected_account_posts,
 * create_social_media_posts — that is a more specific, directly-actionable
 * keyword match than the Work Plan Capabilities section's softer
 * conditional guidance. The table's own header frames it as being for a
 * user "referring to a page or feature by name" — but a goal statement like
 * "I'm interested in making some linkedin posts" matches the same keywords
 * without being that kind of request, and this row had no way to
 * distinguish the two. ENG-1478's fix (teaching Emma to check
 * list_predefined_work_plans) never even got a chance to run, because this
 * row resolved the request first.
 */
describe('AgentMode system prompt - LinkedIn goal vs feature-reference routing (ENG-1484)', () => {
  it('the LinkedIn content/posts/page row now defers to a work-plan check for a stated GOAL, not a literal feature reference', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Exception: if the user is stating a GOAL rather than asking to view/manage what already exists'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'check for a matching predefined work plan first per the Work Plan Capabilities section'
    );
  });

  it('keeps the original row intact for a literal feature/page reference (unchanged behavior)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      '"LinkedIn content", "LinkedIn posts", "LinkedIn page" → **list_connected_account_posts**, **create_social_media_posts**.'
    );
  });
});
