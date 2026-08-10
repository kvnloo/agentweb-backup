import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

/**
 * ENG-827 (Greptile) — the revoke-only publish-consent endpoint.
 *
 * The asymmetry IS the design, so it is what these tests pin. Revoking can only ever
 * make a schedule safer, so it is reachable by the owner and by Emma acting on their
 * instruction. Granting means posts go out that nobody has seen, so no request shape
 * reaches it — not a wrong body, not a truthy value, not a spelling variant.
 *
 * ENG-803's objection to a model-writable hold is honoured by keeping this one
 * direction: a stray revoke is visible, durable and reversible by the owner, whereas a
 * stray grant is an irreversible public post.
 */

jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const SCHEDULE_ID = 'sc-1';
const OWNER = 'user-1';

const req = (body: any, user = { userId: OWNER }) =>
  ({ params: { scheduleId: SCHEDULE_ID }, body, user } as any);

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

describe('revokeScheduledChatPublishConsent (ENG-827)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockScheduleDb.getScheduleById as any).mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      userId: OWNER,
    });
    (mockScheduleDb.updateSchedule as any).mockResolvedValue(undefined);
  });

  it('REVOKES: holds the schedule at the publish step', async () => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ requirePublishApproval: true })
    );
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ requirePublishApproval: true })
    );
  });

  it('writes ONLY the publish key, so a concurrent update cannot clobber it', async () => {
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), res());
    const written = (mockScheduleDb.updateSchedule as any).mock.calls[0][1];
    expect(Object.keys(written).sort()).toEqual(['requirePublishApproval', 'updatedAt']);
  });

  it.each([
    ['a grant', { authorized: true }],
    ['a truthy string', { authorized: 'false' }],
    ['a truthy number', { authorized: 1 }],
    ['an omitted flag', {}],
    ['an empty body', undefined],
  ])('REFUSES %s — publishing is never turned on here', async (_label, body) => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req(body), r);

    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    // ...and it must not even look the schedule up for a request it will not honour
    expect(mockScheduleDb.getScheduleById).not.toHaveBeenCalled();
  });

  it('404s for a schedule belonging to someone else, without writing', async () => {
    (mockScheduleDb.getScheduleById as any).mockResolvedValue({
      scheduleId: SCHEDULE_ID,
      userId: 'someone-else',
    });

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);

    expect(r.status).toHaveBeenCalledWith(404);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('404s for a missing schedule', async () => {
    (mockScheduleDb.getScheduleById as any).mockResolvedValue(null);
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('500s rather than reporting a revoke that did not persist', async () => {
    (mockScheduleDb.updateSchedule as any).mockRejectedValue(new Error('throttled'));
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);
    expect(r.status).toHaveBeenCalledWith(500);
  });
});
