/**
 * ENG-827 — the publish-consent gate has to be on the path a real run takes.
 *
 * The first version of this gate went into `McpToolRegistry` (mcp/server/registry.ts),
 * where Emma's tools are DECLARED. A live Emma session — including every scheduled
 * run, which is what this ticket is about — does not dispatch through that registry:
 * `registerTools()` copies each handler into `ToolRegistry` (this file's subject) as
 * `{name, definition, execute}`, so the raw handler runs and the guard never fires.
 * Every unit test still passed. Exactly the ENG-822 trap, one file over: a fix that
 * looks done and does nothing.
 *
 * These tests exercise the LIVE registry, registered the way registerTools() does it.
 */

import { ToolRegistry, ToolContext } from '../toolRegistry';

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

const ctx = (sessionId: string): ToolContext => ({
  userId: 'user-1',
  sessionId,
  llmModel: 'claude-opus-5',
  service: {},
});

const authorized = {
  scheduleId: SCHEDULE_ID,
  requiredFunctionCalls: ['post_on_connected_account'],
  autopublishAuthorized: true,
  autopublishAuthorizedTools: ['post_on_connected_account'],
};
const revoked = { ...authorized, autopublishAuthorized: false, autopublishAuthorizedTools: [] };

describe('ENG-827 — the live Emma dispatch path enforces publish consent', () => {
  let registry: ToolRegistry;
  let publishHandler: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new ToolRegistry();
    publishHandler = jest.fn().mockResolvedValue({ success: true, post_url: 'https://linkedin.com/p/1' });
    // Registered exactly the way agentModeService.registerTools() does it — the copy
    // that dropped the ENG-822 flag, and that bypasses McpToolRegistry.execute.
    registry.register({
      name: 'post_on_connected_account',
      definition: { type: 'function', function: { name: 'post_on_connected_account' } },
      execute: publishHandler,
    });
    getChatSession.mockResolvedValue(scheduledSession);
  });

  it('does NOT run the publishing handler when consent is not live', async () => {
    getScheduleById.mockResolvedValue(revoked);

    const result: any = await registry.execute(
      'post_on_connected_account', { content: 'hi' }, ctx('sess-scheduled')
    );

    expect(publishHandler).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not authorized to publish');
  });

  it('runs the handler while consent is live', async () => {
    getScheduleById.mockResolvedValue(authorized);

    const result: any = await registry.execute(
      'post_on_connected_account', { content: 'hi' }, ctx('sess-scheduled')
    );

    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('hands the handler a re-check that catches a revocation landing mid-flight', async () => {
    getScheduleById.mockResolvedValue(authorized);
    let recheck: any;
    publishHandler.mockImplementation(async (_args: any, context: any) => {
      getScheduleById.mockResolvedValue(revoked); // owner revokes during the upload
      recheck = await context.assertPublishStillAuthorized();
      return { success: true };
    });

    await registry.execute('post_on_connected_account', { content: 'hi' }, ctx('sess-scheduled'));

    expect(recheck).not.toBeNull();
    expect(recheck.success).toBe(false);
  });

  it('leaves an interactive session alone', async () => {
    getChatSession.mockResolvedValue({ sessionId: 'sess-live', sessionType: 'agent' });

    const result: any = await registry.execute(
      'post_on_connected_account', { content: 'hi' }, ctx('sess-live')
    );

    expect(publishHandler).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(getScheduleById).not.toHaveBeenCalled();
  });
});
