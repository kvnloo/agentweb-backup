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

    it('allows the call when the session read fails, rather than blocking every publish', async () => {
      // Deliberate: refusing here would break interactive publishing for everyone on
      // a transient blip. The between-turn re-check and prompt directive still apply.
      const d = {
        getChatSession: jest.fn(async () => { throw new Error('read failed'); }),
        getScheduleById: jest.fn(async () => AUTHORIZED_SCHEDULE),
      };
      expect(
        await refuseUnauthorizedScheduledPublish('post_on_connected_account', { sessionId: 'sess-1' }, d)
      ).toBeNull();
    });
  });
});
