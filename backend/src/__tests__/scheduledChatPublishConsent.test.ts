jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    updateSchedule: jest.fn().mockResolvedValue(undefined),
  },
  userDb: { getUserById: jest.fn() },
  taskDb: {},
  crmDb: {},
}));

import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

const mockDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const OWNER = 'user-owner';
const SCHEDULE_ID = 'sc-1';

function makeReq(body: any, opts: { userId?: string; delegated?: boolean } = {}): Request {
  return {
    user: { userId: opts.userId ?? OWNER, email: 'o@example.com' },
    delegateInfo: opts.delegated ? { isDelegated: true, adminUserId: 'admin', adminEmail: 'a@x' } : undefined,
    params: { scheduleId: SCHEDULE_ID },
    body,
  } as unknown as Request;
}

function makeRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

/**
 * ENG-827: unattended publish consent is the one irreversible permission on a
 * schedule, so it has its own owner-only endpoint rather than riding on the generic
 * update body. These pin the boundary that separation exists to enforce.
 */
describe('POST /scheduled-chats/:id/publish-consent (ENG-827)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      userId: OWNER,
      requiredFunctionCalls: ['post_on_connected_account'],
    });
  });

  it('GRANTS for the owner and records who consented and when', async () => {
    const res = makeRes();
    await agentModeController.setScheduledChatPublishConsent(makeReq({ authorized: true }), res);
    const [, patch] = (mockDb.updateSchedule as jest.Mock).mock.calls[0];
    expect(patch.autopublishAuthorized).toBe(true);
    expect(patch.autopublishAuthorizedBy).toBe(OWNER);
    expect(patch.autopublishAuthorizedAt).toEqual(expect.any(String));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ autopublishAuthorized: true }));
  });

  // A delegated admin acts as the customer everywhere else, but must not be able to
  // hand out a permission whose entire point is that a specific human accepted it.
  it('REFUSES a grant from a delegated session', async () => {
    const res = makeRes();
    await agentModeController.setScheduledChatPublishConsent(
      makeReq({ authorized: true }, { delegated: true }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('ALLOWS a delegated session to REVOKE — revoking only makes runs safer', async () => {
    const res = makeRes();
    await agentModeController.setScheduledChatPublishConsent(
      makeReq({ authorized: false }, { delegated: true }),
      res
    );
    const [, patch] = (mockDb.updateSchedule as jest.Mock).mock.calls[0];
    expect(patch.autopublishAuthorized).toBe(false);
    expect(patch.autopublishAuthorizedBy).toBeNull();
  });

  it('REFUSES a grant when the schedule designates no publishing tool', async () => {
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      userId: OWNER,
      requiredFunctionCalls: ['you_search_web'],
    });
    const res = makeRes();
    await agentModeController.setScheduledChatPublishConsent(makeReq({ authorized: true }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('404s for a schedule owned by someone else, without leaking its existence', async () => {
    const res = makeRes();
    await agentModeController.setScheduledChatPublishConsent(
      makeReq({ authorized: true }, { userId: 'someone-else' }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean authorized value rather than coercing it', async () => {
    for (const bad of ['true', 1, null, undefined, {}]) {
      const res = makeRes();
      await agentModeController.setScheduledChatPublishConsent(makeReq({ authorized: bad }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });
});
