import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';

// ENG-2262: Emma answered a lead-count rollup purely from memory of an earlier turn, with no
// signal that the underlying CRM list had changed out-of-band (a lead was deleted directly via
// the API, simulating the customer removing it via the CRM UI mid-conversation). She confidently
// restated the stale total with zero tool calls and no caveat. ENG-2211's existing "account for
// every lead" rule only fires once Emma already knows a count changed — it never required her to
// proactively re-check before stating a total as current in the first place.
describe('Agent Mode system prompt — CRM rollup staleness discipline', () => {
  it('requires a fresh CRM query before restating a total/count as current', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      're-run the CRM query before restating one as current, never just recompute it from memory'
    );
  });

  it('distinguishes a stale total from an individual lead\'s own established attribution tag', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'This is NOT the same as an individual lead\'s own already-established attribution tag or quality note'
    );
  });

  it('requires re-querying specifically when a turn asks for a current count or breakdown', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain(
      'Whenever a turn asks for a current count or breakdown ("how many", "total", "right now", any rollup), re-query the CRM rather than repeating an earlier turn\'s number'
    );
  });
});
