import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-2263: Emma correctly re-queried the CRM for the number a turn directly asked about
// ("search across all lists for X, give me an exact total"), but a SECONDARY number in the
// same response — an overall account-wide list/lead count mentioned as supporting context —
// was carried over from a `get_lead_lists` call three turns earlier, after a list had been
// deleted in between, and was tagged `[verified]` as though it had just been confirmed.
// ENG-2262's rule only re-triggers for the number the question is literally about; it says
// nothing about secondary numbers riding along in the same answer.
describe('Agent Mode system prompt — secondary rollup number staleness discipline', () => {
  it('requires the [verified] tag to mean a tool call happened in THIS turn', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'The `[verified]` tag on a CRM number means a tool call happened in THIS turn'
    );
  });

  it('forbids tagging a carried-over secondary number as verified', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'never attach it to a number carried over from earlier in the conversation'
    );
  });

  it('requires a stale secondary number to be labeled as possibly out of date, not silently restated', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Any secondary number you have not freshly re-queried this turn must be stated as being from earlier in the conversation and possibly out of date'
    );
  });
});
