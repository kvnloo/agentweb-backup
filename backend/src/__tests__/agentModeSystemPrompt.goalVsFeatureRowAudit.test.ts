import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

/**
 * ENG-1490 follow-up: dev.md flagged ~15 other "Page & Feature Tool Reference"
 * rows with the same latent goal-vs-feature-reference ambiguity as the
 * LinkedIn row (a specific, keyword-matched row instruction can out-compete
 * the generic Work Plan Capabilities check when a user states a GOAL rather
 * than referring to an existing page/feature). Audited all 19 rows; 7 have a
 * "producing a draft"-shaped primary tool and got the same substitution-framed
 * exception as the LinkedIn row (real matching predefined work plans confirmed
 * live for paid social/ads, landing pages, research/reports, and blog; images,
 * videos, and newsletter included on the same catalog-agnostic reasoning —
 * the mechanism no-ops harmlessly when no plan matches). GTM plan and
 * Tasks/automations rows were examined and NOT patched — different bug shape,
 * not this one (see dev.md).
 *
 * These assertions pin: (a) each row's exception uses the proven substitution
 * framing ("INSTEAD of ... in this same turn"), never the weaker "before
 * drafting" sequencing language that lost to other prompt policies in the
 * original LinkedIn bug, and (b) the original tool-routing text is preserved.
 */
describe('AgentMode system prompt - goal-vs-feature row audit (ENG-1490 follow-up)', () => {
  const rows: Array<{ label: string; keywordFragment: string; primaryTool: string; replacesPhrase: string }> = [
    { label: 'paid social / ads', keywordFragment: '"paid social", "social ads", "meta ads"', primaryTool: 'starting the campaign-creation workflow below', replacesPhrase: 'the recommendation card replaces the freeform build' },
    { label: 'images', keywordFragment: '"images", "ad images", "image generation"', primaryTool: 'calling **generate_image**', replacesPhrase: 'the recommendation card replaces generating' },
    { label: 'videos', keywordFragment: '"videos", "ad videos", "video generation"', primaryTool: 'calling **generate_video**', replacesPhrase: 'the recommendation card replaces generating' },
    { label: 'landing pages', keywordFragment: '"landing page", "landing pages", "create a landing page"', primaryTool: 'starting the CREATE flow below', replacesPhrase: 'the recommendation card replaces the freeform build' },
    { label: 'research/reports', keywordFragment: '"research", "reports", "research reports"', primaryTool: 'calling **perform_deep_research**', replacesPhrase: 'the recommendation card replaces the freeform report' },
    { label: 'newsletter', keywordFragment: '"newsletter", "newsletter page", "email campaign"', primaryTool: 'calling **create_html_from_template**', replacesPhrase: 'the recommendation card replaces drafting' },
    { label: 'blog', keywordFragment: '"blog", "blog articles", "blog page"', primaryTool: 'calling **create_blog_article**', replacesPhrase: 'the recommendation card replaces drafting' },
  ];

  it.each(rows)('$label row: exception uses substitution framing, not "before drafting" sequencing', ({ keywordFragment, primaryTool, replacesPhrase }) => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(keywordFragment);
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      `check for a matching predefined work plan first per the Work Plan Capabilities section. If one clearly fits, propose it via **recommend_predefined_work_plan** INSTEAD of ${primaryTool} in this same turn`
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(replacesPhrase);
  });

  it('never uses the weaker "before drafting content directly" sequencing phrase anywhere in the prompt', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).not.toContain('before drafting content directly.');
  });

  it('preserves the original landing-page CREATE sub-flow tool order unchanged', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'To CREATE a new landing page: call **read_brand_guidelines** first, then **create_lead_list**'
    );
  });

  it('preserves the existing ads spend-confirmation requirement, cross-referenced not duplicated', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'This does not change the existing spend-confirmation requirement below for any write action once a workflow (guided or freeform) is underway.'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'ALWAYS get user confirmation before any write action (create, pause, resume campaigns) — this spends real money.'
    );
  });

  it('preserves the video row\'s CREATE-vs-ANALYZE distinction (describe_video untouched)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'To ANALYZE, transcribe, or repurpose an EXISTING video — including a YouTube link the user shares — use **describe_video**'
    );
  });

  it('does not add an exception to read-only rows (SEO, CRM, brand guidelines, market strategy, knowledge base)', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      '"SEO page", "GEO page", "SEO/GEO", "website metrics", "search metrics", "analytics", "website performance" → **get_seo_metrics**, **get_website_analytics**, **get_clarity_metrics**\n'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      '"CRM", "leads", "contacts", "lead list", "leads page" → **get_lead_lists**, **get_leads**, **search_leads**\n'
    );
  });
});
