/**
 * Telemetry-driven tool guidance fixes (June 9–12 failure analysis):
 *  - linkedin_outreach schema must teach the real per-tier invite limits
 *    (200 free / 300 Premium) — the old "300 max" text caused 201–231 char
 *    invites that free accounts reject. The schema now also documents that
 *    over-limit notes are auto-trimmed on a word boundary at send time, so the
 *    model never burns a retry counting characters (see linkedInOutreachService
 *    .trimInviteMessage and crm.draftInviteNote.trim.test.ts).
 *  - run_local_agent_task rejections must tell the model what to use instead
 *    of just echoing the forbidden regex (55% observed failure rate).
 */
import { validateBrowserTask } from '../emma/localAgentTools';
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

describe('run_local_agent_task rejection guidance', () => {
  it('names alternative tools when a forbidden pattern is matched', () => {
    const rejection = validateBrowserTask('run the npm install command on the repo');
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('coding_agent');
    expect(rejection).toContain('search_web');
    expect(rejection).toContain('READ-ONLY web browsing');
  });

  it('explains what a valid task looks like when no browsing intent is found', () => {
    const rejection = validateBrowserTask('summarize our Q2 strategy');
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('no URL or web-browsing intent');
    expect(rejection).toContain('restate the task with the specific URL');
  });

  it('still accepts a legitimate browsing task', () => {
    const rejection = validateBrowserTask('Visit https://example.com and extract the page title');
    expect(rejection).toBeNull();
  });

  it('still blocks credential-related tasks', () => {
    const rejection = validateBrowserTask('browse to https://example.com and enter my password');
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('cannot run commands');
  });
});
