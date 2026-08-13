import { AGENT_MODE_SYSTEM_PROMPT } from '../docs/agentModeSystemPrompt';
import { emmaToolRegistry } from '../emma/registry';
import '../emma/tools'; // registers add_leads_to_list on the registry

// ENG-1133: a 97-row CSV was hand-split into 25-row add_leads_to_list calls and
// the run hit the whole-turn cap after 75 rows. Emma then handed the whole
// request back to the user to retry — the one continuation that risks
// duplicating the 75 rows that did land.
describe('Agent Mode system prompt — resumable lead imports', () => {
  it('tells Emma to send a whole file in one call rather than hand-splitting it', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Send the WHOLE file in ONE add_leads_to_list call');
  });

  it('states that repeating an already-imported row is safe', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('idempotent');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('never as a duplicate');
  });

  it('routes a partial result into a resume instead of a user-side retry', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('resumable: true');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('unimportedRows');
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('Never close a turn by telling the user to re-run an import themselves');
  });

  // One resume round is not necessarily enough: the write budget can bound a
  // large import, and the resume list itself is capped. Stopping after the
  // first round leaves rows behind while reporting the import finished.
  it('tells Emma to keep resuming until the import reports complete', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('complete: true');
    const description = emmaToolRegistry.getTool('add_leads_to_list')?.definition.description || '';
    expect(description).toContain('complete: true');
  });

  // The detailed resume list is capped, so on a large partial it names only the
  // first slice. Emma has to resume from the uncapped range summary instead, or
  // she finishes the slice, reads `complete: true` and strands the rest.
  it('points Emma at the uncapped range summary, not the capped detail list', () => {
    expect(AGENT_MODE_SYSTEM_PROMPT).toContain('unimportedRowRanges');
    expect(AGENT_MODE_SYSTEM_PROMPT).toMatch(/never is, so resend everything it names/);
    const description = emmaToolRegistry.getTool('add_leads_to_list')?.definition.description || '';
    expect(description).toContain('unimportedRowRanges');
    expect(description).toMatch(/never truncated/);
  });

  it('carries the same resume contract on the tool definition Emma actually reads', () => {
    const description = emmaToolRegistry.getTool('add_leads_to_list')?.definition.description || '';
    expect(description).toContain('unimportedRows');
    expect(description).toMatch(/never end the turn telling the user to retry the import themselves/i);
    // The counts the agent must reconcile before it reports a total.
    expect(description).toContain('reconciliation');
  });
});
