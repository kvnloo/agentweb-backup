import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-2260: Emma inferred a paid channel (Google Ads) for a CRM lead whose only source
// signal was a landing-page name ("via the Mountain View Heat Pump Rebate page") with no
// UTM source, gclid, or other click ID — reasoning from domain-knowledge pattern-matching
// ("rebate pages are a Google Ads thing") rather than an actual tag. The lead was correctly
// categorized the first time a real CRM tool call returned its (untagged) attribution, but
// drifted into "Google Ads" on a later turn when Emma re-derived the rollup from her own
// prior conversational prose instead of the tool data, because that prose never flagged the
// lead as untagged in the first place.
describe('Agent Mode system prompt — untagged lead attribution discipline', () => {
  it('forbids inferring a paid channel from page/campaign context without an explicit tag', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'a landing page name, campaign-adjacent wording, or "this is probably from X campaign" reasoning is not a tag'
    );
  });

  it('requires an untagged lead to be reported as its own distinct bucket', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'report it as a distinct "source unknown / untagged" bucket, never folded into a specific channel\'s count'
    );
  });

  it('requires the untagged status to be stated explicitly on first mention, not just the page/campaign name', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'so the untagged status survives into later turns even if you\'re summarizing from this conversation rather than re-querying the CRM'
    );
  });

  it('requires later-turn rollups to trust the CRM tag over memory of earlier prose', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'When recomputing a rollup in a later turn, trust the CRM tag over your own earlier prose'
    );
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'carry forward the exact tagged/untagged status you (or the tool) established the first time'
    );
  });
});
