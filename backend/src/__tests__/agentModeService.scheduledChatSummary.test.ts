/**
 * ENG-803 — the scheduled-run title suffix must be grounded in what the run DID.
 *
 * Session 0fe2e743 ("Harsha X Reply Guy — Mentions") was titled
 * "… — Replies queued" while zero replies were posted: the agent had drafted
 * five replies and invented an "active X publishing gate" to justify never
 * calling twitter_manage_post. The title suffix comes from
 * generateScheduledChatSummary, which previously saw ONLY the request text and
 * the agent's own prose — structurally incapable of noticing that no posting
 * tool ever ran, so it faithfully echoed the response's false claim.
 *
 * These tests pin the fix: the executed tool names are passed to the summarizer
 * as evidence, and the summarizer is instructed not to use publish verbs that
 * the executed tools do not support.
 */

import { agentModeService } from '../services/agentModeService';

describe('generateScheduledChatSummary — grounded in executed tool calls (ENG-803)', () => {
  let callLLMSpy: jest.SpyInstance;

  const mockSummary = (summary: string | null) => {
    callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: summary } }] } as any);
  };

  /** The user-role payload actually sent to the summarizer model. */
  const sentUserContent = (): string =>
    callLLMSpy.mock.calls[0][1].find((m: any) => m.role === 'user').content;

  const sentSystemContent = (): string =>
    callLLMSpy.mock.calls[0][1].find((m: any) => m.role === 'system').content;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the executed tool names to the summarizer as evidence', async () => {
    mockSummary('Drafts Prepared');

    await agentModeService.generateScheduledChatSummary(
      'POST replies directly as @harshmoney123 using twitter_manage_post',
      'I did not auto-post replies because of the publishing gate. 5 queued.',
      ['twitter_outreach', 'get_brand_guidelines', 'twitter_outreach']
    );

    const user = sentUserContent();
    expect(user).toContain('Tools actually executed:');
    const evidenceLine = user.split('Tools actually executed: ')[1].split('\n')[0];
    // the read tools the run DID call are listed, de-duplicated…
    expect(evidenceLine).toBe('twitter_outreach, get_brand_guidelines');
    // …and the posting tool it skipped is absent from the evidence, even though
    // the request text names it — the whole point of grounding.
    expect(evidenceLine).not.toContain('twitter_manage_post');
  });

  it('instructs the summarizer not to claim posted/queued when no publishing tool ran', async () => {
    mockSummary('Nothing Posted');

    await agentModeService.generateScheduledChatSummary('Reply to mentions', 'Replies queued.', [
      'twitter_outreach',
    ]);

    const system = sentSystemContent();
    expect(system).toContain('must reflect the executed tools');
    expect(system).toContain('Queued');
  });

  it('reports "none" when the run executed no tools at all', async () => {
    mockSummary('No Action Taken');

    await agentModeService.generateScheduledChatSummary('Reply to mentions', 'All done!', []);

    expect(sentUserContent()).toContain('Tools actually executed: none');
  });

  it('treats an omitted tool list as no evidence rather than crashing (back-compat)', async () => {
    mockSummary('Report Generated');

    // older call sites (and any caller without tool-call data) must keep working
    const summary = await agentModeService.generateScheduledChatSummary('Weekly report', 'Done.');

    expect(summary).toBe('Report Generated');
    expect(sentUserContent()).toContain('Tools actually executed: none');
  });

  it('de-duplicates and caps the evidence list so a long run cannot bloat the prompt', async () => {
    mockSummary('Leads Enriched');

    const many = Array.from({ length: 60 }, (_, i) => `tool_${i}`);
    await agentModeService.generateScheduledChatSummary('Enrich leads', 'Done.', [
      ...many,
      ...many, // duplicates collapse
    ]);

    const listed = sentUserContent().split('Tools actually executed: ')[1].split('\n')[0];
    const names = listed.split(', ');
    expect(names.length).toBe(40);
    expect(new Set(names).size).toBe(40);
  });

  it('still returns null when the summarizer fails, so the caller keeps the existing title', async () => {
    jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('model unavailable'));

    const summary = await agentModeService.generateScheduledChatSummary('Reply to mentions', 'Done.', [
      'twitter_outreach',
    ]);

    expect(summary).toBeNull();
  });
});
