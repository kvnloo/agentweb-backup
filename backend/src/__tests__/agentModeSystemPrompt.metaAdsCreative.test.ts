import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-382: The "B2B Meta Ads Intelligence Refresh" scheduled task silently
// under-delivered for ~3 months because the system prompt steered the agent to
// extract competitor ad creative by scraping the public Meta Ads Library with
// Playwright. Meta's Ads Library uses DOM virtualization + lazy-loading, so a
// headless browser can never reliably extract ad copy/creative at scale — the
// run produced a near-empty knowledge base. The reliable Foreplay discovery
// source (search_ads_knowledge_base source='discovery') already exists. The
// prompt must now prefer that reliable source, demote DOM scraping to
// best-effort only, and keep the no-fabrication rule.
describe('AgentMode system prompt - Meta ad creative extraction source guidance', () => {
  it('prefers the reliable Foreplay discovery source for ad-creative intelligence', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain("search_ads_knowledge_base` with `source='discovery'`");
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('PREFER the reliable structured source');
  });

  it('mentions the official Meta Ad Library API as a reliable alternative', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('official Meta Ad Library API');
  });

  it('demotes Playwright DOM scraping of the Ads Library to best-effort only and names the DOM virtualization cause', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('best-effort only');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('DOM virtualization');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('cannot reliably extract ad copy or creative at scale');
  });

  it('keeps the no-fabrication rule for empty ad results', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never fabricate, estimate, or invent ad copy');
  });

  // ENG-382 was a keyword/category research task ("catalog 100 winning B2B ads
  // across these keywords"), NOT a single-company lookup. The guidance must
  // route that broad research shape to discovery via `query`/`niche` too, so
  // the agent doesn't conclude discovery is company-only and fall back to
  // scraping.
  it('routes broad keyword/theme research (not tied to one company) to the discovery source', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('keyword/theme/category research that is NOT tied to one company');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Do NOT force a `company_name` when the task is broad keyword research');
  });
});
