import {
  MAX_PUBLISH_PRESS_ATTEMPTS,
  isPublishOnlyUnmet,
  shouldStopPressingForPublish,
  classifyPublishStall,
} from '../utils/publishPressCircuitBreaker';

/** A minimal succeeded ledger entry — classifyPublishStall's route match needs
 * the call's arguments (action/platform), not just its name. */
const entry = (name: string, args?: Record<string, unknown>) => ({ name, arguments: args });

describe('shouldStopPressingForPublish (ENG-947)', () => {
  const press = (over: Partial<Parameters<typeof shouldStopPressingForPublish>[0]> = {}) =>
    shouldStopPressingForPublish({
      pressAttempt: MAX_PUBLISH_PRESS_ATTEMPTS,
      unmetRequiredFunctions: ['post_on_connected_account'],
      ...over,
    });

  it('trips once the press budget is spent and the only unmet requirement is a publish tool', () => {
    expect(press()).toBe(true);
    expect(press({ pressAttempt: MAX_PUBLISH_PRESS_ATTEMPTS + 5 })).toBe(true);
  });

  it('leaves the early presses alone — a run that complies on a later attempt must still get there', () => {
    for (let pressAttempt = 1; pressAttempt < MAX_PUBLISH_PRESS_ATTEMPTS; pressAttempt++) {
      expect(press({ pressAttempt })).toBe(false);
    }
  });

  it('never trips when nothing is unmet', () => {
    expect(press({ unmetRequiredFunctions: [] })).toBe(false);
    expect(press({ unmetRequiredFunctions: undefined as any })).toBe(false);
  });

  it('never trips while a NON-publish requirement is also unmet — pressing for those is cheap and reversible', () => {
    expect(press({ unmetRequiredFunctions: ['post_on_connected_account', 'analyze_competitors'] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['get_marketing_tips'] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['generate_image'] })).toBe(false);
  });

  it('covers the whole publish family, including prefix-matched tools registered later', () => {
    expect(press({ unmetRequiredFunctions: ['publish_blog_article'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['publish_landing_page_changes'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['post_on_account'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['post_on_some_future_network'] })).toBe(true);
    expect(press({ unmetRequiredFunctions: ['publish_some_future_surface'] })).toBe(true);
    expect(
      press({ unmetRequiredFunctions: ['post_on_connected_account', 'publish_blog_article'] })
    ).toBe(true);
  });

  it('ignores malformed entries rather than tripping on them', () => {
    expect(press({ unmetRequiredFunctions: [null as any] })).toBe(false);
    expect(press({ unmetRequiredFunctions: ['post_on_connected_account', undefined as any] })).toBe(false);
  });

  it('honours an explicit press budget override', () => {
    expect(press({ pressAttempt: 2, maxPressAttempts: 2 })).toBe(true);
    expect(press({ pressAttempt: 2, maxPressAttempts: 9 })).toBe(false);
  });
});

describe('isPublishOnlyUnmet (ENG-947)', () => {
  it('is true only when every outstanding requirement is a publish tool', () => {
    expect(isPublishOnlyUnmet(['post_on_connected_account'])).toBe(true);
    expect(isPublishOnlyUnmet(['post_on_connected_account', 'publish_blog_article'])).toBe(true);
    expect(isPublishOnlyUnmet(['post_on_connected_account', 'get_marketing_tips'])).toBe(false);
    expect(isPublishOnlyUnmet(['generate_image'])).toBe(false);
  });

  it('is false for an empty, missing or malformed set — the press counter must not advance on it', () => {
    expect(isPublishOnlyUnmet([])).toBe(false);
    expect(isPublishOnlyUnmet(undefined as any)).toBe(false);
    expect(isPublishOnlyUnmet([null as any])).toBe(false);
  });

  /**
   * ENG-1599 — scoped to tools with a KNOWN equivalence route
   * (EQUIVALENT_PUBLISH_ROUTES), not the whole SEND_TOOLS/isPowerTool family.
   * An earlier version of this fix used isPowerTool and was caught before
   * shipping: it would have pulled delete_leads, enrich_leads_execute,
   * import_leads_from_search, linkedin_outreach, twitter_outreach, and plain
   * send_email/send_email_to_lead into the circuit breaker even though none of
   * them has any documented alternate route to anything — so a successful call
   * to one of them proves nothing about an unrelated still-unmet requirement.
   * These must stay OUTSIDE isPublishOnlyUnmet, exactly as before that widening,
   * so a schedule requiring one of them still gets the full 20-attempt budget.
   */
  it('does NOT cover tools with no known equivalence route, even though they are irreversible SEND_TOOLS', () => {
    expect(isPublishOnlyUnmet(['delete_leads'])).toBe(false);
    expect(isPublishOnlyUnmet(['delete_leads_by_filter'])).toBe(false);
    expect(isPublishOnlyUnmet(['delete_lead_list'])).toBe(false);
    expect(isPublishOnlyUnmet(['enrich_leads_execute'])).toBe(false);
    expect(isPublishOnlyUnmet(['import_leads_from_search'])).toBe(false);
    expect(isPublishOnlyUnmet(['linkedin_outreach'])).toBe(false);
    expect(isPublishOnlyUnmet(['twitter_outreach'])).toBe(false);
    expect(isPublishOnlyUnmet(['send_email'])).toBe(false);
    expect(isPublishOnlyUnmet(['send_email_to_lead'])).toBe(false);
  });

  it('DOES cover tools that have a known equivalence route', () => {
    expect(isPublishOnlyUnmet(['twitter_manage_post'])).toBe(true);
    expect(isPublishOnlyUnmet(['post_thread'])).toBe(true);
    expect(isPublishOnlyUnmet(['email'])).toBe(true);
    expect(isPublishOnlyUnmet(['send_email_from_sender'])).toBe(true);
  });
});

/**
 * ENG-947 — a stalled publish requirement has TWO causes, and calling both
 * "held for approval" reports a live post as unpublished.
 *
 * Production case, schedule 34154af9 "Kevin — X Evening Post", run
 * 2026-08-11T08:07:26Z: requiredFunctionCalls names post_on_connected_account,
 * but the prompt asks for a 2-3 tweet THREAD, so the model used
 * twitter_manage_post instead — once, successfully, summary "Thread Published".
 * post_on_connected_account stayed at actual 0, so the requirement was unmet and
 * the run pressed to attempt 20.
 *
 * The breaker is right to stop pressing there — re-asking for a tool the model
 * has already worked around is exactly as futile as re-asking for a refused one.
 * But the run DID publish, so marking it publishHeldForApproval would tell the
 * owner their thread is waiting for approval while it is live on X. The two
 * cases need different answers: one is "approve it", the other is "your schedule
 * names the wrong tool".
 */
describe('classifyPublishStall (ENG-947)', () => {
  const classify = (over: Partial<Parameters<typeof classifyPublishStall>[0]> = {}) =>
    classifyPublishStall({
      pressAttempt: MAX_PUBLISH_PRESS_ATTEMPTS,
      unmetRequiredFunctions: ['post_on_connected_account'],
      externalWritesSucceeded: [],
      ...over,
    });

  it('keeps pressing while the budget is unspent and nothing else was written', () => {
    expect(classify({ pressAttempt: 1 })).toBeNull();
  });

  /**
   * ENG-1599: requiredFunctionCalls named twitter_manage_post, but the schedule's
   * own prompt publishes via post_on_connected_account. Before this fix, the
   * mismatch reason was gated behind the same 3-press budget as the other two
   * causes, so the FIRST press after the successful post_on_connected_account
   * call still fired "Please try again. Make sure to twitter_manage_post" — and
   * the model complied by posting a second, redundant thread live on X. Live
   * forensics on session 90ad8838 confirm this run actually took that path
   * (attempt 2, functionCallMatches: [twitter_outreach, twitter_manage_post]).
   * A mismatch must be reported on the very first press, not the third.
   */
  it('reports a mismatch on the FIRST press, not the third — pressing again cannot fix a name mismatch', () => {
    expect(
      classify({ pressAttempt: 1, externalWritesSucceeded: [entry('twitter_manage_post', { action: 'post_thread' })] }),
    ).toBe('requirement-names-unused-publish-tool');
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['twitter_manage_post'],
        externalWritesSucceeded: [entry('post_on_connected_account', { platform: 'twitter' })],
      }),
    ).toBe('requirement-names-unused-publish-tool');
  });

  it('keeps pressing when something reversible is also outstanding', () => {
    expect(classify({ unmetRequiredFunctions: ['post_on_connected_account', 'analyze_competitors'] })).toBeNull();
  });

  it('reports a genuine withhold when the run published nothing', () => {
    expect(classify()).toBe('held-for-approval');
  });

  it('reports a TOOL MISMATCH when the run published through a different tool', () => {
    // The real 2026-08-11 evening run.
    expect(classify({ externalWritesSucceeded: [entry('twitter_manage_post', { action: 'post_thread' })] })).toBe(
      'requirement-names-unused-publish-tool',
    );
  });

  it('ignores a FAILED external write — nothing was published, so it is still a withhold', () => {
    // Callers pass only succeeded writes; this pins the contract at the boundary.
    expect(classify({ externalWritesSucceeded: [] })).toBe('held-for-approval');
  });

  it('does not treat the unmet tool itself as evidence it published', () => {
    // Defensive: if a caller ever passed the unmet name through, the run plainly
    // did NOT succeed at it (that is why it is unmet), so this must not flip to
    // mismatch and silently suppress the approval signal.
    expect(classify({ externalWritesSucceeded: [entry('post_on_connected_account')] })).toBe(
      'held-for-approval',
    );
  });

  it('ignores non-write tools entirely', () => {
    expect(classify({ externalWritesSucceeded: [entry('you_search_web'), entry('save_memory')] })).toBe(
      'held-for-approval',
    );
  });

  /**
   * Found on a live preview run (session 42004fa0, 2026-08-13): the model called
   * post_on_connected_account three times and every call failed with "No twitter
   * account connected". Nothing was withheld and nothing was published — the tool
   * is broken for this account. Reporting that as held-for-approval sends the
   * owner looking for an approval queue when what they need is to reconnect the
   * account, which is the same class of false report this ticket family is about.
   */
  it('reports a FAILING TOOL when the run did call the publish tool and it errored', () => {
    expect(classify({ publishToolsAttempted: ['post_on_connected_account'] })).toBe(
      'publish-tool-failing',
    );
  });

  it('still reports a withhold when the publish tool was never reached', () => {
    expect(classify({ publishToolsAttempted: [] })).toBe('held-for-approval');
  });

  it('lets a SUCCEEDED write through another tool outrank a failing attempt', () => {
    // The thread went out via twitter_manage_post; that the named tool was also
    // tried and failed does not make the live post disappear.
    expect(
      classify({
        publishToolsAttempted: ['post_on_connected_account'],
        externalWritesSucceeded: [entry('twitter_manage_post', { action: 'post_thread' })],
      }),
    ).toBe('requirement-names-unused-publish-tool');
  });

  it('only counts attempts at a tool that is actually still unmet', () => {
    // An attempt at some unrelated publish tool says nothing about why THIS
    // requirement stalled.
    expect(classify({ publishToolsAttempted: ['publish_landing_page_changes'] })).toBe(
      'held-for-approval',
    );
  });

  /**
   * ENG-1599 regression — caught before shipping. A version of this fix widened
   * `wroteSomethingElse` to "any succeeded isPowerTool call", which would have
   * misfired on an ordinary CRM schedule: import_leads_from_search ->
   * enrich_leads_execute -> send_email_from_sender, required only
   * send_email_from_sender. Enrichment succeeding before the email was ever
   * attempted has no registered relationship to a send at all — it is a
   * different, earlier step in the SAME workflow, not an alternate route to the
   * same outcome — so it must NOT be read as "the schedule's requiredFunctionCalls
   * names a tool this run does not use". The run needs to keep pressing so the
   * model can actually get to sending.
   */
  it('does NOT treat an unrelated successful CRM write as evidence a required send will never happen', () => {
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['send_email_from_sender'],
        externalWritesSucceeded: [entry('enrich_leads_execute')],
      }),
    ).toBeNull();
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['send_email_from_sender'],
        externalWritesSucceeded: [entry('import_leads_from_search'), entry('delete_leads_by_filter')],
      }),
    ).toBeNull();
    // Even at full budget, still just a genuine withhold, not a mismatch —
    // pressing was still worth doing.
    expect(
      classify({
        unmetRequiredFunctions: ['send_email_from_sender'],
        externalWritesSucceeded: [entry('enrich_leads_execute')],
      }),
    ).toBe('held-for-approval');
  });

  /**
   * The legitimate mirror case: `email` and `send_email_from_sender` ARE a
   * registered bidirectional pair (ENG-1276), so a succeeded `email` call
   * genuinely does satisfy a `send_email_from_sender` requirement outcome —
   * this must still report the mismatch immediately, same as the twitter pair.
   * `send_email_from_sender`'s route to `email` is scoped to `actions: ['send']`
   * (email's own registry entry has send/save/draft actions); `email`'s route
   * back to `send_email_from_sender` has no qualifier at all.
   */
  it('still reports a mismatch for the registered email/send_email_from_sender pair', () => {
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['send_email_from_sender'],
        externalWritesSucceeded: [entry('email', { action: 'send' })],
      }),
    ).toBe('requirement-names-unused-publish-tool');
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['email'],
        externalWritesSucceeded: [entry('send_email_from_sender')],
      }),
    ).toBe('requirement-names-unused-publish-tool');
  });

  /**
   * ENG-1599 review (CodeRabbit) — matching on `route.tool` alone, ignoring
   * `route.actions`/`route.platforms`, let an UNRELATED call satisfy a route's
   * shape check:
   *  - a `twitter_manage_post` REPLY (not `post_thread`) would have matched
   *    `post_on_connected_account`'s route, which is scoped to `post_thread`
   *    only — a reply to someone else's tweet is not "the schedule's own
   *    content going out", so it must NOT stop the press.
   *  - a `post_on_connected_account` call to a non-Twitter platform would have
   *    matched `twitter_manage_post`'s route, which is scoped to
   *    `platforms: ['twitter']` only — a LinkedIn post proves nothing about a
   *    Twitter-only grant.
   * Both must still allow pressing to continue for the real requirement.
   */
  it('does NOT match a route whose action/platform qualifier the actual call fails', () => {
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['post_on_connected_account'],
        externalWritesSucceeded: [entry('twitter_manage_post', { action: 'reply' })],
      }),
    ).toBeNull();
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['twitter_manage_post'],
        externalWritesSucceeded: [entry('post_on_connected_account', { platform: 'linkedin' })],
      }),
    ).toBeNull();
  });

  /**
   * Same qualifier check, but confirming the POSITIVE case still works when the
   * action/platform IS present and matches — i.e. this isn't accidentally
   * requiring arguments to be absent, it requires them to be RIGHT.
   */
  it('matches a route when the action/platform qualifier IS satisfied', () => {
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['post_on_connected_account'],
        externalWritesSucceeded: [entry('twitter_manage_post', { action: 'post_thread' })],
      }),
    ).toBe('requirement-names-unused-publish-tool');
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['twitter_manage_post'],
        externalWritesSucceeded: [entry('post_on_connected_account', { platform: 'twitter' })],
      }),
    ).toBe('requirement-names-unused-publish-tool');
  });

  /**
   * ENG-1599 review (CodeRabbit) — a schedule that requires BOTH
   * post_on_connected_account AND twitter_manage_post as SEPARATE line items
   * wants two distinct actions. A succeeded post_on_connected_account call
   * already satisfies its OWN requirement (so it drops out of
   * unmetRequiredFunctions), but was still being read as "wrote something
   * else" for the still-unmet twitter_manage_post via the same reverse route —
   * stopping the run before twitter_manage_post was ever attempted, even
   * though the schedule explicitly asked for it too. heldToFunctionNames
   * mirrors callSatisfiesRequirement's own double-credit suppression: when
   * BOTH the route's target requirement and the call's own name are held-to
   * requirements, the cross-credit (here, cross-disqualification) is
   * suppressed and the run keeps pressing for the one still genuinely unmet.
   */
  it('does not let a call that already satisfied ITS OWN requirement disqualify a sibling held-to requirement', () => {
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['twitter_manage_post'],
        externalWritesSucceeded: [entry('post_on_connected_account', { platform: 'twitter' })],
        heldToFunctionNames: ['post_on_connected_account', 'twitter_manage_post'],
      }),
    ).toBeNull();
    // Without the full held-to set (the pre-fix shape), the same call still
    // correctly reports the mismatch — this is the ENG-1599 case itself.
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['twitter_manage_post'],
        externalWritesSucceeded: [entry('post_on_connected_account', { platform: 'twitter' })],
      }),
    ).toBe('requirement-names-unused-publish-tool');
    // A held-to set that names the requirement but not the call (or vice
    // versa) must not suppress — only BOTH names being separately required
    // triggers the suppression.
    expect(
      classify({
        pressAttempt: 1,
        unmetRequiredFunctions: ['twitter_manage_post'],
        externalWritesSucceeded: [entry('post_on_connected_account', { platform: 'twitter' })],
        heldToFunctionNames: ['twitter_manage_post'],
      }),
    ).toBe('requirement-names-unused-publish-tool');
  });
});
