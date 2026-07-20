/**
 * Telemetry-driven tool guidance fixes (June 9–12 failure analysis):
 *  - linkedin_outreach schema must teach the real per-tier invite limits
 *    (200 free / 300 Premium) — the old "300 max" text caused 201–231 char
 *    invites that free accounts reject. The schema now also documents that
 *    over-limit notes are auto-trimmed on a word boundary at send time, so the
 *    model never burns a retry counting characters (see linkedInOutreachService
 *    .trimInviteMessage and crm.draftInviteNote.trim.test.ts).
 *  - run_local_agent_task rejections must tell the model what to use instead
 *    of a dead end. ENG-383 (2026-07): the local agent relay is retired, so the
 *    "rejection" is now the permanent deprecation error — it must still name
 *    the replacement tool.
 */
import { LOCAL_AGENT_DEPRECATION_ERROR } from '../emma/localAgentTools';
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';

describe('linkedin_outreach invite limit guidance', () => {
  const definition = emmaToolRegistry.getTool('linkedin_outreach')?.definition as any;

  it('documents the 200-char free-tier limit and the auto-trim safety net in the description', () => {
    expect(definition).toBeDefined();
    expect(definition.description).toContain('200 characters on free LinkedIn accounts');
    expect(definition.description).toContain('300 on Premium');
    // The model is steered to aim short, and told over-limit notes are auto-trimmed
    // on a word boundary (not rejected) — so it never burns a retry on length.
    expect(definition.description.toLowerCase()).toContain('200 characters or fewer');
    expect(definition.description.toLowerCase()).toContain('auto-trims');
    expect(definition.description.toLowerCase()).toContain('word boundary');
  });

  it('documents the per-tier limit and auto-trim on the message parameter itself', () => {
    const messageDescription: string = definition.inputSchema.properties.message.description;
    expect(messageDescription).toContain('200 characters or fewer');
    expect(messageDescription).toContain('300 on Premium');
    expect(messageDescription.toLowerCase()).toContain('auto-trims');
  });

  it('warns against inviting already-connected profiles', () => {
    expect(definition.description).toContain('FIRST_DEGREE');
    expect(definition.description).toContain('use send-message instead');
  });
});

describe('run_local_agent_task deprecation guidance (ENG-383)', () => {
  it('every call fails with an error that names the replacement tool, not a dead end', async () => {
    const result = await emmaToolRegistry.execute(
      'run_local_agent_task',
      { task: 'Visit https://example.com and extract the page title' },
      { userId: 'u1' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe(LOCAL_AGENT_DEPRECATION_ERROR);
    expect(result.error).toContain('search_web');
  });

  it('the tool description itself steers the model away before it even calls', () => {
    const definition = emmaToolRegistry.getTool('run_local_agent_task')?.definition as any;
    expect(definition).toBeDefined();
    expect(definition.description).toMatch(/^DEPRECATED \(2026-07\):/);
    expect(definition.description).toContain('you_search_web');
  });
});
