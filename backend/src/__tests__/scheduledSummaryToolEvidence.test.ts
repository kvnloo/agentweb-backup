/**
 * ENG-803 — the title evidence filter: SUCCEEDED, not merely ATTEMPTED.
 *
 * Greptile review #19. runScheduledChat grounds the generated session title in the
 * run's tool ledger, but that ledger keeps FAILED and preflight-rejected calls too.
 * Mapping every entry to its name handed the summarizer a `twitter_manage_post`
 * entry for a call that errored — and it would faithfully title the run "Replies
 * Posted". That is exactly the false-success title this ticket is about
 * ("Scheduled: Harsha X Reply Guy — Mentions (auto) — Replies queued", zero replies
 * posted), re-created by the fix meant to prevent it.
 *
 * The predicate is asserted here directly, mirroring the call site, because it is
 * the thing that decides whether a title can lie.
 */

// Mirrors the filter in agentModeController.runScheduledChat. A call counts only
// when it has no top-level `error` (the repo-wide failure marker, per
// countFailedToolCalls) and its result did not report success:false — which is how
// a preflight rejection comes back while still looking like a completed call.
const succeededNames = (toolCalls: any[]): string[] =>
  (toolCalls || [])
    .filter((call: any) => call && !('error' in call) && call?.result?.success !== false)
    .map((call: any) => call?.name)
    .filter(Boolean);

describe('scheduled title evidence — only successful calls count (ENG-803)', () => {
  it('excludes a publish tool that errored, so the title cannot claim it posted', () => {
    const ledger = [
      { name: 'twitter_outreach', result: { success: true } },
      { name: 'twitter_manage_post', error: 'Rate limited by X API (429)' },
    ];
    expect(succeededNames(ledger)).toEqual(['twitter_outreach']);
    expect(succeededNames(ledger)).not.toContain('twitter_manage_post');
  });

  it('excludes a preflight rejection, which completes without an error field', () => {
    const ledger = [
      { name: 'post_on_connected_account', result: { success: false, error: 'No connected X account' } },
    ];
    expect(succeededNames(ledger)).toEqual([]);
  });

  it('keeps a genuinely successful publish, so a real post is still credited', () => {
    const ledger = [
      { name: 'twitter_manage_post', result: { success: true, tweetId: '123' } },
    ];
    expect(succeededNames(ledger)).toEqual(['twitter_manage_post']);
  });

  it('keeps calls that report no explicit success flag', () => {
    // Most tools return a payload rather than {success}. Treating a missing flag as
    // failure would erase almost every tool from the evidence and make every title
    // read as "nothing happened".
    expect(succeededNames([{ name: 'get_brand_guidelines', result: { guidelines: 'x' } }]))
      .toEqual(['get_brand_guidelines']);
    expect(succeededNames([{ name: 'you_search_web' }])).toEqual(['you_search_web']);
  });

  it('reproduces the reported run: every publish attempt failed, so evidence is empty', () => {
    // With no publishing tool in the evidence, the summarizer is instructed not to
    // use "Posted"/"Queued" — the whole point of grounding the title.
    const ledger = [
      { name: 'twitter_outreach', result: { success: true } },
      { name: 'twitter_manage_post', error: 'gate' },
      { name: 'twitter_manage_post', result: { success: false } },
    ];
    expect(succeededNames(ledger)).toEqual(['twitter_outreach']);
  });

  it('survives a malformed ledger without throwing', () => {
    expect(succeededNames([null, undefined, {}, { name: '' }] as any)).toEqual([]);
    expect(succeededNames([])).toEqual([]);
  });
});
