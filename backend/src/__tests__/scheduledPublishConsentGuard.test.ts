import { refuseUnauthorizedScheduledPublish } from '../utils/scheduledPublishConsentGuard';

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

const AUTHORIZED_SCHEDULE = {
  scheduleId: '1c20ada1-0000-4000-8000-000000000001',
  requiredFunctionCalls: ['post_on_connected_account'],
  autopublishAuthorized: true,
  autopublishAuthorizedTools: ['post_on_connected_account'],
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
    const d = deps(SCHEDULED_SESSION, {
      ...AUTHORIZED_SCHEDULE,
      autopublishAuthorized: false,
      autopublishAuthorizedTools: [],
    });

    const refusal = await refuseUnauthorizedScheduledPublish(
      'post_on_connected_account', { sessionId: 'sess-1' }, d
    );

    expect(refusal).not.toBeNull();
    expect(refusal!.success).toBe(false);
    expect(refusal!.error).toContain('not authorized to publish');
    // Must not send the model back into a retry loop — that was the reported burn.
    expect(refusal!.error).toContain('Do NOT retry this tool in this run');
  });

  it('REFUSES a publish tool outside the authorized scope', async () => {
    const d = deps(SCHEDULED_SESSION, {
      ...AUTHORIZED_SCHEDULE,
      requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
      autopublishAuthorizedTools: ['post_on_connected_account'],
    });

    const refusal = await refuseUnauthorizedScheduledPublish(
      'publish_blog_article', { sessionId: 'sess-1' }, d
    );

    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain('post_on_connected_account');
  });

  it('covers a NEW publish tool by prefix, with no per-tool registration', async () => {
    const d = deps(SCHEDULED_SESSION, {
      ...AUTHORIZED_SCHEDULE,
      autopublishAuthorized: false,
      autopublishAuthorizedTools: [],
    });
    expect(
      await refuseUnauthorizedScheduledPublish('publish_some_future_surface', { sessionId: 'sess-1' }, d)
    ).not.toBeNull();
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
        requiredFunctionCalls: ['post_on_connected_account', 'publish_blog_article'],
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
        { ...AUTHORIZED_SCHEDULE, autopublishAuthorized: false, autopublishAuthorizedTools: [] }
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
