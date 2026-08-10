/**
 * ENG-827 — the publish-consent check must be WIRED INTO DISPATCH, not merely
 * available as a helper.
 *
 * The runner's between-attempt re-check cannot see a revocation that lands while a
 * worker invocation is already running, and one invocation can make many tool calls
 * over minutes. So the gate has to sit where every Emma tool call passes through —
 * the same place as the anonymous-session and external-MCP refusals. These tests
 * assert the OUTCOME at that seam: the publishing handler must not run at all.
 */

import { McpToolRegistry } from '../registry';

const SCHEDULE_ID = '1c20ada1-0000-4000-8000-000000000001';

const scheduledSession = {
  sessionId: 'sess-scheduled',
  sessionType: 'scheduled',
  pageIdentifier: `Scheduled: Kevin — Daily LinkedIn Post|scheduleId:${SCHEDULE_ID}`,
  // ENG-827: the scope this run was ADMITTED under. The guard intersects live
  // schedule state with it, so a mid-run grant cannot widen a draft-only run.
  publishAdmission: { authorized: true, tools: ['post_on_connected_account'], recordedAt: '2026-08-10T01:00:00.000Z' },
};

const getChatSession = jest.fn();
const getScheduleById = jest.fn();

jest.mock('../../../services/chatbotService', () => ({
  chatbotDb: { getChatSession: (id: string) => getChatSession(id) },
}));
jest.mock('../../../services/db', () => ({
  scheduleDb: { getScheduleById: (id: string) => getScheduleById(id) },
}));

describe('ENG-827 — dispatch refuses an unauthorized scheduled publish', () => {
  let registry: McpToolRegistry;
  let publishHandler: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new McpToolRegistry();
    publishHandler = jest.fn().mockResolvedValue({ success: true, postUrl: 'https://linkedin.com/post/1' });
    registry.register({
      name: 'post_on_connected_account',
      definition: { name: 'post_on_connected_account' },
      execute: publishHandler,
    });
    getChatSession.mockResolvedValue(scheduledSession);
  });

  it('does NOT run the publishing handler when consent was revoked mid-run', async () => {
    getScheduleById.mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
      requirePublishApproval: true,
    });

    const result: any = await registry.execute(
      'post_on_connected_account',
      { content: 'hello world' },
      { userId: 'u1', sessionId: 'sess-scheduled' }
    );

    // Not reaching the handler IS the fix — the post is irreversible once made.
    expect(publishHandler).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authorized to publish');
  });

  it('runs the handler normally while consent is live', async () => {
    getScheduleById.mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
    });

    const result: any = await registry.execute(
      'post_on_connected_account',
      { content: 'hello world' },
      { userId: 'u1', sessionId: 'sess-scheduled' }
    );

    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('does NOT run the handler when the session read keeps failing', async () => {
    // A datastore blip must not become a way past a withdrawn consent.
    getChatSession.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    const result: any = await registry.execute(
      'post_on_connected_account',
      { content: 'hello world' },
      { userId: 'u1', sessionId: 'sess-scheduled' }
    );

    expect(publishHandler).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  // Greptile (security): admission and the irreversible act are separate, and the
  // work between them can run for minutes (media download, YouTube upload). The
  // handler therefore gets a re-validation to run at its LAST moment.
  it('hands the publishing handler a re-check that refuses once consent is revoked in flight', async () => {
    getScheduleById.mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      requiredFunctionCalls: ['post_on_connected_account'],
    });

    let recheck: any;
    publishHandler.mockImplementation(async (_args: any, context: any) => {
      // Stands in for the slow work: the owner revokes while it is running.
      getScheduleById.mockResolvedValue({
        scheduleId: SCHEDULE_ID,
        requiredFunctionCalls: ['post_on_connected_account'],
        requirePublishApproval: true,
      });
      recheck = await context.assertPublishStillAuthorized();
      return { success: true };
    });

    await registry.execute(
      'post_on_connected_account',
      { content: 'hello world' },
      { userId: 'u1', sessionId: 'sess-scheduled' }
    );

    // Admission passed (consent was live then) — the LAST-MOMENT check is what
    // catches the withdrawal that landed during the work.
    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(recheck).not.toBeNull();
    expect(recheck.success).toBe(false);
    expect(recheck.error).toContain('not authorized to publish');
  });

  it('does not attach the re-check to a non-publishing tool', async () => {
    const readHandler = jest.fn().mockResolvedValue({ success: true });
    registry.register({
      name: 'read_brand_guidelines',
      definition: { name: 'read_brand_guidelines' },
      execute: readHandler,
    });

    await registry.execute('read_brand_guidelines', {}, { userId: 'u1', sessionId: 'sess-scheduled' });

    expect(readHandler.mock.calls[0][1].assertPublishStillAuthorized).toBeUndefined();
  });

  it('leaves interactive publishing untouched', async () => {
    getChatSession.mockResolvedValue({ sessionId: 'sess-interactive', sessionType: 'agent' });

    const result: any = await registry.execute(
      'post_on_connected_account',
      { content: 'hello world' },
      { userId: 'u1', sessionId: 'sess-interactive' }
    );

    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(getScheduleById).not.toHaveBeenCalled();
  });
});
