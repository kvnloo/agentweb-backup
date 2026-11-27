import {
  refuseUnauthorizedScheduledPublish,
  publishWithdrawnMidFlight,
  attachPublishRevalidation,
} from '../utils/scheduledPublishConsentGuard';
import { chatbotDb } from '../services/chatbotService';
import { scheduleDb } from '../services/db';
import { getAccountsWithOwnerIncludingOrgShared } from '../services/connectedAccountsDb';

jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn() } }));
jest.mock('../services/db', () => ({ scheduleDb: { getScheduleById: jest.fn() } }));
// ENG-1616 — mocked so the default-deps integration test below (which deliberately
// exercises defaultDeps() itself, not a hand-written mock) can control what account
// list the real resolveAccountPlatform sees, without hitting DynamoDB.
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  SOCIAL_POSTING_PLATFORMS: ['twitter', 'linkedin', 'instagram', 'youtube'],
}));

/**
 * ENG-827 (Greptile) — a revocation that lands MID-TURN must stop the publish.
 *
 * The scheduled runner re-reads consent before each verification attempt, but one
 * attempt is a single worker invocation that can iterate over many internal model
 * steps and tool calls for minutes. Enforcement only at that loop boundary means an
 * owner who switches consent off ten seconds into a turn does not stop the publish
 * that turn makes a minute later. These tests pin the execution-time check that
 * closes the window.
 */

const SCHEDULED_SESSION = {
  sessionId: 'sess-1',
  sessionType: 'scheduled',
  pageIdentifier: 'Scheduled: Kevin — Daily LinkedIn Post|scheduleId:1c20ada1-0000-4000-8000-000000000001',
  // The authorization this run was ADMITTED under, stamped by the runner before the
  // first turn. Live schedule state is intersected with it and can only narrow.
  publishAdmission: {
    authorized: true,
    tools: ['post_on_connected_account'],
    recordedAt: '2026-08-10T01:00:00.000Z',
  },
};

// Affirmative, tool-scoped consent — the only shape that authorizes anything.
const AUTHORIZED_SCHEDULE = {
  scheduleId: '1c20ada1-0000-4000-8000-000000000001',
  requiredFunctionCalls: ['post_on_connected_account'],
  autopublishAuthorized: true,
  autopublishAuthorizedTools: ['post_on_connected_account'],
};

/** Consent withdrawn — absence of a grant is the withheld state. */
const WITHHELD_SCHEDULE = {
  ...AUTHORIZED_SCHEDULE,
  autopublishAuthorized: false,
  autopublishAuthorizedTools: [],
};

const deps = (session: any, schedule: any) => ({
  getChatSession: jest.fn(async () => session),
  getScheduleById: jest.fn(async () => schedule),
});

describe('refuseUnauthorizedScheduledPublish (ENG-827)', () => {
  it('allows a publish while consent is live and covers this tool', async () => {
    const d = deps(SCHEDULED_SESSION, AUTHORIZED_SCHEDULE);
    expect(
      await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
    ).toBeNull();
  });

  it('REFUSES once consent has been revoked, even mid-turn', async () => {
    // The run was admitted authorized; the owner switched it off while the worker
    // was already inside this turn. Storage is the source of truth at call time.
    const d = deps(SCHEDULED_SESSION, WITHHELD_SCHEDULE);

    const refusal = await refuseUnauthorizedScheduledPublish(
      'post_on_connected_account', { sessionId: 'sess-1' }, d
    );

    expect(refusal).not.toBeNull();
    expect(refusal!.success).toBe(false);
    expect(refusal).toMatchObject({ blocked: true, reason: 'publish_consent' });
    expect(refusal!.error).toContain('not authorized to publish');
    // Must not send the model back into a retry loop — that was the reported burn.
    expect(refusal!.error).toContain('Do NOT retry this tool in this run');
  });

  // Consent is recorded against the tools the owner could see when they gave it, so a
  // run authorized for one publish tool must not reach for another.
  it('REFUSES a publish tool outside the approved scope', async () => {
    const d = deps(SCHEDULED_SESSION, AUTHORIZED_SCHEDULE);
    const refusal = await refuseUnauthorizedScheduledPublish(
      'publish_blog_article', { sessionId: 'sess-1' }, d
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain('post_on_connected_account');
  });

  it('covers a NEW publish tool by prefix, with no per-tool registration', async () => {
    const d = deps(SCHEDULED_SESSION, WITHHELD_SCHEDULE);
    expect(
      await refuseUnauthorizedScheduledPublish('publish_some_future_surface', { sessionId: 'sess-1' }, d)
    ).not.toBeNull();
  });

  // ENG-1045 follow-up. Before this, a grant for post_on_connected_account alone hard
  // -refused twitter_manage_post outright — so the completion checker's equivalence
  // route (a thread satisfies the requirement) was correct but unreachable: the model
  // was refused before it ever got a chance to publish the thread. Live-verified on
  // preview 2026-08-17.
  describe('outcome-equivalent publish routes (ENG-1045)', () => {
    it('ALLOWS a thread through twitter_manage_post on a grant scoped to post_on_connected_account', async () => {
      const d = deps(SCHEDULED_SESSION, AUTHORIZED_SCHEDULE);
      expect(
        await refuseUnauthorizedScheduledPublish(
          'twitter_manage_post', { sessionId: 'sess-1' }, d, { action: 'post_thread' }
        )
      ).toBeNull();
    });

    // reply/quote_tweet/retweet are NOT in post_on_connected_account's
    // equivalence list — each responds to or reshares someone ELSE's content,
    // not the schedule's own standalone content going out (ENG-1276 follow-up).
    // Granting the whole tool name would authorize more than the literal
    // consent covers.
    it('still REFUSES a reply, quote-tweet, or retweet through the same tool — none is an equivalent route', async () => {
      for (const action of ['reply', 'quote_tweet', 'retweet']) {
        const d = deps(SCHEDULED_SESSION, AUTHORIZED_SCHEDULE);
        const refusal = await refuseUnauthorizedScheduledPublish(
          'twitter_manage_post', { sessionId: 'sess-1' }, d, { action }
        );
        expect([action, refusal]).toEqual([action, expect.objectContaining({ success: false })]);
        expect([action, refusal!.error]).toEqual([action, expect.stringContaining('post_on_connected_account')]);
      }
    });

    it('still REFUSES once consent is revoked, even for an equivalent route', async () => {
      const d = deps(SCHEDULED_SESSION, WITHHELD_SCHEDULE);
      const refusal = await refuseUnauthorizedScheduledPublish(
        'twitter_manage_post', { sessionId: 'sess-1' }, d, { action: 'post_thread' }
      );
      expect(refusal).not.toBeNull();
    });
  });

  /**
   * ENG-1616 — the reverse (ENG-1599) route requires trusting `args.platform`, but
   * `postOnConnectedAccount` ignores `platform` outright once `account_id` is present,
   * so the route failed closed on ANY account_id-bearing call, regardless of whether
   * the account was actually the authorized one. `list_connected_accounts` pairs every
   * account_id with its platform and tells the model to use account_id once it knows
   * it, so a call shaped `post_on_connected_account(account_id: '...')` is a plausible
   * way this route gets invoked — this closes that gap proactively.
   *
   * This is NOT a reproduction of an observed production failure: no account_id-shaped
   * call has been seen hitting this refusal in production. (Session 672b3af7 on
   * schedule 1d001fba-0fb7-4bcd-80f6-6041b244a442, 2026-08-27 — the incident ENG-1616
   * was filed from — is a different call: it passed `platform`, not `account_id`, and
   * ran hours BEFORE ENG-1599 merged later that same day, so it never touched this
   * route at all. ENG-1599's own platform-only route already covers it.)
   */
  describe('the ENG-1599 reverse route with account_id present (ENG-1616)', () => {
    const SESSION_WITH_USER = { ...SCHEDULED_SESSION, userId: 'harsha-user-id' };
    const TWITTER_ONLY_SCHEDULE = {
      ...AUTHORIZED_SCHEDULE,
      requiredFunctionCalls: ['twitter_manage_post'],
      autopublishAuthorizedTools: ['twitter_manage_post'],
    };
    const TWITTER_ONLY_ADMISSION = {
      authorized: true,
      tools: ['twitter_manage_post'],
      recordedAt: '2026-08-27T08:18:05.550Z',
    };

    it('ALLOWS a standalone tweet by account_id once the account is verified as the connected Twitter account', async () => {
      const d = {
        ...deps(
          { ...SESSION_WITH_USER, publishAdmission: TWITTER_ONLY_ADMISSION },
          TWITTER_ONLY_SCHEDULE
        ),
        resolveAccountPlatform: jest.fn(async () => 'twitter'),
      };
      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        d,
        { account_id: '1340767380', content: 'one tweet' }
      );
      expect(refusal).toBeNull();
      expect(d.resolveAccountPlatform).toHaveBeenCalledWith('1340767380', 'harsha-user-id');
    });

    it('still REFUSES when the resolved account is a DIFFERENT platform than the grant covers', async () => {
      const d = {
        ...deps(
          { ...SESSION_WITH_USER, publishAdmission: TWITTER_ONLY_ADMISSION },
          TWITTER_ONLY_SCHEDULE
        ),
        resolveAccountPlatform: jest.fn(async () => 'linkedin'),
      };
      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        d,
        { account_id: 'li-account', content: 'one post' }
      );
      expect(refusal).not.toBeNull();
    });

    it('still fails CLOSED when no resolver is available (preserves the prior default)', async () => {
      const d = deps(
        { ...SESSION_WITH_USER, publishAdmission: TWITTER_ONLY_ADMISSION },
        TWITTER_ONLY_SCHEDULE
      );
      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        d,
        { account_id: '1340767380', content: 'one tweet' }
      );
      expect(refusal).not.toBeNull();
    });

    it('still fails CLOSED when the account lookup itself errors', async () => {
      const d = {
        ...deps(
          { ...SESSION_WITH_USER, publishAdmission: TWITTER_ONLY_ADMISSION },
          TWITTER_ONLY_SCHEDULE
        ),
        resolveAccountPlatform: jest.fn(async () => { throw new Error('throttled'); }),
      };
      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        d,
        { account_id: '1340767380', content: 'one tweet' }
      );
      expect(refusal).not.toBeNull();
    });

    it('does not bother resolving the account when the exact tool name is already granted', async () => {
      const d = {
        ...deps(SCHEDULED_SESSION, AUTHORIZED_SCHEDULE),
        resolveAccountPlatform: jest.fn(),
      };
      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        d,
        { account_id: 'some-id', content: 'x' }
      );
      expect(refusal).toBeNull();
      expect(d.resolveAccountPlatform).not.toHaveBeenCalled();
    });

    /**
     * ENG-1616 — every test above supplies its OWN hand-written `resolveAccountPlatform`
     * mock, so none of them ever runs `defaultDeps()`'s actual implementation: the
     * dynamic `import('../services/connectedAccountsDb')`, the `SOCIAL_POSTING_PLATFORMS`
     * filter, and the `.find()` by account_id. That is the one piece of new logic in this
     * PR that isn't a pure function, and a typo in the import or an inverted filter there
     * would ship green without this test. Omitting `deps` (4th positional arg not passed,
     * i.e. undefined) makes `refuseUnauthorizedScheduledPublish` build its own deps via
     * `defaultDeps()`, exercising the real wiring end to end.
     */
    it('defaultDeps().resolveAccountPlatform (the real implementation, not a mock) authorizes by account_id', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        ...SESSION_WITH_USER,
        publishAdmission: TWITTER_ONLY_ADMISSION,
      });
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(TWITTER_ONLY_SCHEDULE);
      (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
        { account_id: '1340767380', platform: 'twitter', account_name: '@harshmoney123' },
        { account_id: 'other-id', platform: 'linkedin', account_name: 'unrelated' },
      ]);

      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        undefined,
        { account_id: '1340767380', content: 'one tweet' }
      );

      expect(refusal).toBeNull();
      expect(getAccountsWithOwnerIncludingOrgShared).toHaveBeenCalledWith('harsha-user-id');
    });

    it('defaultDeps().resolveAccountPlatform (the real implementation) still refuses when no account matches', async () => {
      (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
        ...SESSION_WITH_USER,
        publishAdmission: TWITTER_ONLY_ADMISSION,
      });
      (scheduleDb.getScheduleById as jest.Mock).mockResolvedValue(TWITTER_ONLY_SCHEDULE);
      (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([
        { account_id: 'other-id', platform: 'linkedin', account_name: 'unrelated' },
      ]);

      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account',
        { sessionId: 'sess-1' },
        undefined,
        { account_id: '1340767380', content: 'one tweet' }
      );

      expect(refusal).not.toBeNull();
    });
  });

  // Greptile (security): re-reading live state closes the revocation window, but on
  // its own it also OPENS one in the other direction — a grant landing mid-run would
  // publish content that a draft-only run had already generated under a prompt
  // telling it not to publish, and that the owner never saw. Rights are intersected
  // with the admitted scope, so live state can only ever narrow them.
  describe('a run keeps the permissions it began with', () => {
    it('REFUSES when consent was granted AFTER this run was admitted', async () => {
      // Admitted draft-only (no stamp — the runner writes one only when authorized),
      // then the owner ticked the box while the run was still executing.
      const d = deps(
        { ...SCHEDULED_SESSION, publishAdmission: undefined },
        AUTHORIZED_SCHEDULE
      );

      const refusal = await refuseUnauthorizedScheduledPublish(
        'post_on_connected_account', { sessionId: 'sess-1' }, d
      );

      expect(refusal).not.toBeNull();
      expect(refusal!.error).toContain('a run keeps the permissions it began with');
      expect(refusal!.error).toContain('takes effect on the next run');
      // Cheap: a run with no publishing rights is refused without a schedule read.
      expect(d.getScheduleById).not.toHaveBeenCalled();
    });

    it('REFUSES a tool ADDED to the approved scope after admission', async () => {
      // Admitted for post_on_connected_account only; the owner then widened the
      // schedule's approved list. The widening is invisible to this run.
      const d = deps(SCHEDULED_SESSION, {
        ...AUTHORIZED_SCHEDULE,
        autopublishAuthorizedTools: ['post_on_connected_account', 'publish_blog_article'],
      });
      expect(
        await refuseUnauthorizedScheduledPublish('publish_blog_article', { sessionId: 'sess-1' }, d)
      ).not.toBeNull();
      // ...while the tool it WAS admitted for still goes through.
      expect(
        await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
      ).toBeNull();
    });

    it('treats a malformed admission stamp as not authorized', async () => {
      const d = deps(
        { ...SCHEDULED_SESSION, publishAdmission: { authorized: 'true', tools: 'post_on_connected_account' } },
        AUTHORIZED_SCHEDULE
      );
      expect(
        await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
      ).not.toBeNull();
    });

    it('treats an admission stamped with an EMPTY scope as not authorized', async () => {
      // Unknown scope authorizes nothing — the same rule the resolver applies.
      const d = deps(
        { ...SCHEDULED_SESSION, publishAdmission: { authorized: true, tools: [], recordedAt: 'x' } },
        AUTHORIZED_SCHEDULE
      );
      expect(
        await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
      ).not.toBeNull();
    });
  });

  // Greptile (security): `twitter_manage_post` posts a NEW public thread and
  // `linkedin_manage_post` reposts — public writes under the owner's name that the
  // name-based classification missed entirely, so they reached an unattended run with
  // no consent check at all.
  describe('action-scoped publishing tools', () => {
    it('REFUSES an X thread from a run with no publishing rights', async () => {
      const d = deps({ ...SCHEDULED_SESSION, publishAdmission: undefined }, AUTHORIZED_SCHEDULE);
      const refusal = await refuseUnauthorizedScheduledPublish(
        'twitter_manage_post', { sessionId: 'sess-1' }, d, { action: 'post_thread' }
      );
      expect(refusal).not.toBeNull();
      expect(refusal!.error).toContain('not authorized to publish');
    });

    it('REFUSES a LinkedIn repost once consent is revoked', async () => {
      const d = deps(
        {
          ...SCHEDULED_SESSION,
          publishAdmission: { authorized: true, tools: ['linkedin_manage_post'], recordedAt: 'x' },
        },
        WITHHELD_SCHEDULE
      );
      expect(
        await refuseUnauthorizedScheduledPublish(
          'linkedin_manage_post', { sessionId: 'sess-1' }, d, { action: 'repost' }
        )
      ).not.toBeNull();
    });

    it('leaves an analytics read alone — without reading anything at all', async () => {
      const d = deps({ ...SCHEDULED_SESSION, publishAdmission: undefined }, AUTHORIZED_SCHEDULE);
      expect(
        await refuseUnauthorizedScheduledPublish(
          'linkedin_manage_post', { sessionId: 'sess-1' }, d, { action: 'get_analytics' }
        )
      ).toBeNull();
      expect(d.getChatSession).not.toHaveBeenCalled();
    });

    it('ALLOWS a thread the owner authorized this run for', async () => {
      const d = deps(
        {
          ...SCHEDULED_SESSION,
          publishAdmission: { authorized: true, tools: ['twitter_manage_post'], recordedAt: 'x' },
        },
        {
          ...AUTHORIZED_SCHEDULE,
          requiredFunctionCalls: ['twitter_manage_post'],
          autopublishAuthorizedTools: ['twitter_manage_post'],
        }
      );
      expect(
        await refuseUnauthorizedScheduledPublish(
          'twitter_manage_post', { sessionId: 'sess-1' }, d, { action: 'post_thread' }
        )
      ).toBeNull();
    });
  });

  it('fails CLOSED when the schedule cannot be read', async () => {
    const d = {
      getChatSession: jest.fn(async () => SCHEDULED_SESSION),
      getScheduleById: jest.fn(async () => { throw new Error('throttled'); }),
    };
    const refusal = await refuseUnauthorizedScheduledPublish(
      'post_on_connected_account', { sessionId: 'sess-1' }, d
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain('treated as withheld');
  });

  it('fails CLOSED when the scheduled session names no schedule', async () => {
    const d = deps({ ...SCHEDULED_SESSION, pageIdentifier: 'Scheduled: orphaned' }, AUTHORIZED_SCHEDULE);
    expect(
      await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
    ).not.toBeNull();
  });

  // The schedule NAME is owner-supplied text that sits IN FRONT of the authoritative
  // id in `"<name>|scheduleId:<id>"`. An unanchored parser takes the FIRST match, so
  // a name containing `scheduleId:<other>` silently resolves this run's consent
  // against a DIFFERENT schedule's record. Non-vacuous: with the previous
  // `/scheduleId:([a-f0-9-]+)/` this read the decoy id and looked up the wrong row.
  it('resolves consent against the STAMPED schedule, not one named in the title', async () => {
    const spoofed = {
      ...SCHEDULED_SESSION,
      pageIdentifier:
        'Evil scheduleId:deadbeef-0000-4000-8000-00000000dead' +
        '|scheduleId:1c20ada1-0000-4000-8000-000000000001',
    };
    const d = deps(spoofed, AUTHORIZED_SCHEDULE);

    expect(
      await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
    ).toBeNull();
    // Assert the OUTCOME that matters: which record the decision was read from.
    expect(d.getScheduleById).toHaveBeenCalledWith('1c20ada1-0000-4000-8000-000000000001');
    expect(d.getScheduleById).not.toHaveBeenCalledWith('deadbeef-0000-4000-8000-00000000dead');
  });

  describe('does not touch the interactive path', () => {
    it('allows a publish in an interactive session without reading any schedule', async () => {
      // A human is in the conversation and approves there and then.
      const d = deps({ sessionId: 'sess-2', sessionType: 'agent' }, AUTHORIZED_SCHEDULE);
      expect(
        await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-2' }, d)
      ).toBeNull();
      expect(d.getScheduleById).not.toHaveBeenCalled();
    });

    it('does not read anything for a non-publishing tool', async () => {
      const d = deps(SCHEDULED_SESSION, AUTHORIZED_SCHEDULE);
      expect(
        await refuseUnauthorizedScheduledPublish('read_brand_guidelines', { sessionId: 'sess-1' }, d)
      ).toBeNull();
      expect(d.getChatSession).not.toHaveBeenCalled();
    });

    it('rides out a SINGLE session-read blip and proceeds', async () => {
      // One dropped connection must not refuse a human's approved post.
      let calls = 0;
      const d = {
        getChatSession: jest.fn(async () => {
          calls++;
          if (calls === 1) throw new Error('transient');
          return { sessionId: 'sess-2', sessionType: 'agent' };
        }),
        getScheduleById: jest.fn(async () => AUTHORIZED_SCHEDULE),
      };
      expect(
        await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-2' }, d)
      ).toBeNull();
      expect(d.getChatSession).toHaveBeenCalledTimes(2);
    });
  });

  // Greptile (security): the session read is what identifies an unattended run, so
  // a failure is "unknown", not "probably interactive". Permitting there let a
  // datastore blip bypass a consent the owner had just withdrawn — and a live post
  // cannot be un-made.
  it('REFUSES when the session cannot be read even after a retry', async () => {
    const d = {
      getChatSession: jest.fn(async () => { throw new Error('read failed'); }),
      getScheduleById: jest.fn(async () => AUTHORIZED_SCHEDULE),
    };

    const refusal = await refuseUnauthorizedScheduledPublish(
      'post_on_connected_account', { sessionId: 'sess-1' }, d
    );

    expect(refusal).not.toBeNull();
    expect(refusal!.success).toBe(false);
    expect(refusal!.error).toContain('could not be confirmed');
    expect(d.getChatSession).toHaveBeenCalledTimes(2);
  });
});

/**
 * The mid-flight re-check, which the dispatch-time check cannot cover on its own.
 *
 * A handler that does slow work between admission and the irreversible act —
 * resolving accounts, uploading a video, minutes for YouTube — would otherwise
 * publish long after the owner switched consent off, because the decision was taken
 * at the START of work that outlived it.
 */
describe('attachPublishRevalidation / publishWithdrawnMidFlight (ENG-827)', () => {
  it('leaves a non-publishing tool\'s context untouched (same object, no hook)', () => {
    const context = { sessionId: 'sess-1' };
    expect(attachPublishRevalidation('read_brand_guidelines', context)).toBe(context);
  });

  it('leaves an action-scoped READ untouched — analytics must not pay for a re-check', () => {
    const context = { sessionId: 'sess-1' };
    expect(
      attachPublishRevalidation('linkedin_manage_post', context, { action: 'get_analytics' })
    ).toBe(context);
  });

  it('attaches the hook for a publishing call, preserving the original context', () => {
    const context = { sessionId: 'sess-1', userId: 'u1' };
    const wrapped = attachPublishRevalidation('post_on_connected_account', context);
    expect(wrapped).not.toBe(context);
    expect(wrapped.sessionId).toBe('sess-1');
    expect(wrapped.userId).toBe('u1');
    expect(typeof wrapped.assertPublishStillAuthorized).toBe('function');
  });

  it('tolerates a missing context rather than throwing at dispatch', () => {
    const wrapped = attachPublishRevalidation('post_on_connected_account', undefined);
    expect(typeof wrapped.assertPublishStillAuthorized).toBe('function');
  });

  it('proceeds when no hook was attached — direct service and interactive calls', async () => {
    expect(await publishWithdrawnMidFlight(undefined)).toBeNull();
    expect(await publishWithdrawnMidFlight({})).toBeNull();
    expect(await publishWithdrawnMidFlight({ sessionId: 'sess-1' })).toBeNull();
  });

  it('hands back the hook\'s refusal so the handler abandons the post', async () => {
    const refusal = { success: false as const, error: 'consent withdrawn' };
    expect(
      await publishWithdrawnMidFlight({ assertPublishStillAuthorized: async () => refusal })
    ).toBe(refusal);
  });

  it('proceeds when the hook clears the call', async () => {
    expect(
      await publishWithdrawnMidFlight({ assertPublishStillAuthorized: async () => null })
    ).toBeNull();
  });

  // The whole point of the pair, end to end: attach at dispatch, then INVOKE it after
  // the owner revokes. Attaching a hook nobody calls proves nothing, and the earlier
  // cases stub the hook rather than exercising the real one.
  it('the attached hook REFUSES once consent is revoked while the handler works', async () => {
    const { chatbotDb } = require('../services/chatbotService');
    const { scheduleDb } = require('../services/db');
    chatbotDb.getChatSession.mockResolvedValue({
      sessionId: 'sess-1',
      sessionType: 'scheduled',
      pageIdentifier: 'Kevin|scheduleId:1c20ada1-0000-4000-8000-000000000001',
      publishAdmission: { authorized: true, tools: ['twitter_manage_post'], recordedAt: 'x' },
    });
    // Admitted while publishing was allowed...
    scheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: '1c20ada1-0000-4000-8000-000000000001',
      requiredFunctionCalls: ['twitter_manage_post'],
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['twitter_manage_post'],
    });
    const wrapped = attachPublishRevalidation(
      'twitter_manage_post', { sessionId: 'sess-1' }, { action: 'post_thread' }
    );
    expect(await publishWithdrawnMidFlight(wrapped)).toBeNull();

    // ...the owner switches the hold on while the upload is still running.
    scheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: '1c20ada1-0000-4000-8000-000000000001',
      requiredFunctionCalls: ['twitter_manage_post'],
      autopublishAuthorized: false,
      autopublishAuthorizedTools: [],
    });
    const refusal = await publishWithdrawnMidFlight(wrapped);
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain('not authorized to publish');
  });
});

/**
 * With no deps supplied the guard resolves its own against the real datastores. That
 * is the wiring EVERY live dispatch uses — every other test here injects fakes, so
 * without this the production path is the one path never exercised.
 */
describe('default dependency resolution (ENG-827)', () => {
  it('reads the session and schedule through the real db modules', async () => {
    const { chatbotDb } = require('../services/chatbotService');
    const { scheduleDb } = require('../services/db');
    chatbotDb.getChatSession.mockResolvedValue({
      sessionId: 'sess-1',
      sessionType: 'scheduled',
      pageIdentifier: `Kevin — Daily LinkedIn Post|scheduleId:${'1c20ada1-0000-4000-8000-000000000001'}`,
      publishAdmission: { authorized: true, tools: ['post_on_connected_account'], recordedAt: 'x' },
    });
    scheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: '1c20ada1-0000-4000-8000-000000000001',
      requiredFunctionCalls: ['post_on_connected_account'],
      autopublishAuthorized: true,
      autopublishAuthorizedTools: ['post_on_connected_account'],
    });

    expect(
      await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' })
    ).toBeNull();
    expect(chatbotDb.getChatSession).toHaveBeenCalledWith('sess-1');
    // ENG-2816 (step 3): the schedule is read CONSISTENTLY: whether a visitor has marked it is a security decision about a public post.
    expect(scheduleDb.getScheduleById).toHaveBeenCalledWith('1c20ada1-0000-4000-8000-000000000001', { consistent: true });
  });

  it('refuses through the real modules when the owner holds the schedule', async () => {
    const { chatbotDb } = require('../services/chatbotService');
    const { scheduleDb } = require('../services/db');
    chatbotDb.getChatSession.mockResolvedValue({
      sessionId: 'sess-1',
      sessionType: 'scheduled',
      pageIdentifier: 'Kevin|scheduleId:1c20ada1-0000-4000-8000-000000000001',
      publishAdmission: { authorized: true, tools: ['post_on_connected_account'], recordedAt: 'x' },
    });
    scheduleDb.getScheduleById.mockResolvedValue({
      scheduleId: '1c20ada1-0000-4000-8000-000000000001',
      autopublishAuthorized: false,
    });

    const refusal = await refuseUnauthorizedScheduledPublish(
      'post_on_connected_account', { sessionId: 'sess-1' }
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain('not authorized to publish');
  });
});
