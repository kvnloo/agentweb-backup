/**
 * ENG-2782 S1 — the backend owns every piece of copy and every option the
 * Slack-start wizard renders, and validates answers against that same config.
 */
import {
  getSlackStartConfig,
  validateAnswer,
  isHighBudget,
  ANSWER_FIELDS,
} from '../../services/slackStart/slackStartConfig';

describe('slack-start config', () => {
  const config = getSlackStartConfig();

  it('describes six one-question steps in the approved order', () => {
    expect(config.steps.map((s) => s.id)).toEqual(['start', 'source', 'role', 'sector', 'tools', 'adSpend']);
    for (const step of config.steps) {
      expect(step.heading.length).toBeGreaterThan(0);
      expect(step.subline.length).toBeGreaterThan(0);
    }
  });

  it('serves the approved option lists for each answer step', () => {
    const labels = (id: string) => config.steps.find((s) => s.id === id)!.options!.map((o) => o.label);
    expect(labels('source')).toEqual([
      'LinkedIn', 'Twitter / X', 'Reddit', 'Google', 'ChatGPT / Claude / Perplexity', 'Product Hunt',
      'A friend or colleague', 'An event', 'Slack Marketplace', 'A newsletter or podcast',
    ]);
    expect(labels('role')).toEqual([
      'Founder / CEO', 'Head of Marketing / Growth', 'Marketing manager or specialist',
      'Agency owner / freelancer', 'Sales / RevOps', 'Something else',
    ]);
    expect(labels('sector')).toHaveLength(6);
    expect(labels('tools')).toEqual([
      'Meta Ads', 'Google Ads', 'LinkedIn Ads', 'HubSpot', 'ActiveCampaign', 'Shopify', 'Webflow', 'WordPress', 'Google Analytics',
    ]);
    expect(labels('adSpend')).toEqual(['Nothing yet', 'Under $1k', '$1k – $5k', '$5k – $20k', '$20k – $100k', '$100k+']);
  });

  it('marks single vs multi select and tells the visitor the tools step connects nothing', () => {
    const kind = (id: string) => config.steps.find((s) => s.id === id)!.kind;
    expect([kind('source'), kind('role'), kind('sector'), kind('tools'), kind('adSpend')]).toEqual([
      'single', 'single', 'multi', 'multi', 'single',
    ]);
    const tools = config.steps.find((s) => s.id === 'tools')!;
    expect(tools.note).toMatch(/nothing gets connected/i);
    expect(tools.note).toMatch(/slack/i);
  });

  it('never claims an invite was sent in the pending (flag-off) copy', () => {
    expect(config.screens.pending.heading + config.screens.pending.body).not.toMatch(/invite (was|has been) sent/i);
    expect(config.screens.gettingReady.heading.length).toBeGreaterThan(0);
  });

  it('does not expose internal routing flags (high-budget) to the browser', () => {
    expect(JSON.stringify(config)).not.toMatch(/highBudget|francisco/i);
  });

  it('validates answers strictly against the option ids', () => {
    expect(ANSWER_FIELDS).toEqual(['source', 'role', 'sector', 'tools', 'adSpend']);
    expect(validateAnswer('source', 'linkedin')).toEqual({ ok: true, value: 'linkedin' });
    expect(validateAnswer('source', 'myspace').ok).toBe(false);
    expect(validateAnswer('source', ['linkedin']).ok).toBe(false);
    expect(validateAnswer('sector', ['saas', 'agency', 'saas'])).toEqual({ ok: true, value: ['saas', 'agency'] });
    expect(validateAnswer('sector', []).ok).toBe(false);
    expect(validateAnswer('tools', ['meta_ads', 'nope']).ok).toBe(false);
    expect(validateAnswer('tools', 'meta_ads').ok).toBe(false);
  });

  it('flags $5k+ monthly budgets as high budget', () => {
    expect(['none', 'under_1k', '1k_5k'].map(isHighBudget)).toEqual([false, false, false]);
    expect(['5k_20k', '20k_100k', '100k_plus'].map(isHighBudget)).toEqual([true, true, true]);
    expect(isHighBudget(undefined)).toBe(false);
  });
});
