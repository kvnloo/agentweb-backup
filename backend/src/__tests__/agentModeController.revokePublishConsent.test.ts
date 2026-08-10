import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

/**
 * ENG-827 — the publish-consent endpoint.
 *
 * Consent to publish unreviewed to a live account is the one irreversible permission on
 * a schedule, so it gets its own endpoint rather than riding on the generic update body.
 * That makes three boundaries explicit and testable instead of implicit:
 *
 *   - GRANTING is the OWNER's decision. A delegated admin acts as the customer
 *     everywhere else in this API, but must not hand this one out on their behalf.
 *   - A grant needs a DESIGNATED publishing tool, because consent is recorded against
 *     the tool it covers. Consent with no scope would either silently do nothing or
 *     become a mandate to use any publishing tool.
 *   - REVOKING is always allowed, including from a delegated session — it only ever
 *     makes a schedule safer.
 */

jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const SCHEDULE_ID = 'sc-1';
const OWNER = 'user-1';

const req = (body: any, extra: any = {}) =>
  ({ params: { scheduleId: SCHEDULE_ID }, body, user: { userId: OWNER }, ...extra } as any);

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const PUBLISHING_SCHEDULE = {
  scheduleId: SCHEDULE_ID,
  userId: OWNER,
  requiredFunctionCalls: ['read_brand_guidelines', 'post_on_connected_account'],
};

describe('scheduled-chat publish consent (ENG-827)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockScheduleDb.getScheduleById as any).mockResolvedValue(PUBLISHING_SCHEDULE);
    (mockScheduleDb.updateSchedule as any).mockResolvedValue(undefined);
  });

  it('GRANTS, recording the approved tool and who approved it', async () => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), r);

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({
        autopublishAuthorized: true,
        autopublishAuthorizedTools: ['post_on_connected_account'],
        autopublishAuthorizedBy: OWNER,
      }),
      // ENG-827: a grant is conditioned on the tools it was derived from.
      { requiredFunctionCalls: PUBLISHING_SCHEDULE.requiredFunctionCalls }
    );
    expect(r.json).toHaveBeenCalledWith(
      expect.objectContaining({ autopublishAuthorized: true })
    );
  });

  it('records ONLY the publishing tools, never the whole required list', async () => {
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), res());
    const written = (mockScheduleDb.updateSchedule as any).mock.calls[0][1];
    expect(written.autopublishAuthorizedTools).toEqual(['post_on_connected_account']);
    expect(written.autopublishAuthorizedTools).not.toContain('read_brand_guidelines');
  });

  it('REVOKES, clearing the scope and the audit fields', async () => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({
        autopublishAuthorized: false,
        autopublishAuthorizedTools: [],
        autopublishAuthorizedAt: null,
        autopublishAuthorizedBy: null,
      }),
      // A revoke is unconditional — narrowing must always be available.
      undefined
    );
  });

  // The boundary that matters most: an admin viewing a customer's account cannot
  // decide, on their behalf, that the customer's posts go out unseen.
  it('REFUSES a grant from a delegated session', async () => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(
      req({ authorized: true }, { delegateInfo: { isDelegated: true, adminUserId: 'admin-1' } }),
      r
    );

    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('ALLOWS a revoke from a delegated session — it only makes the schedule safer', async () => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(
      req({ authorized: false }, { delegateInfo: { isDelegated: true, adminUserId: 'admin-1' } }),
      r
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ autopublishAuthorized: false }),
      undefined
    );
  });

  it('REFUSES a grant on a schedule that designates no publishing tool', async () => {
    // Consent is recorded against a tool. With none named there is nothing to record,
    // and accepting it would look like it worked while authorizing nothing.
    (mockScheduleDb.getScheduleById as any).mockResolvedValue({
      ...PUBLISHING_SCHEDULE,
      requiredFunctionCalls: ['read_brand_guidelines'],
    });

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), r);

    expect(r.status).toHaveBeenCalledWith(400);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ['a truthy string', { authorized: 'true' }],
    ['a number', { authorized: 1 }],
    ['an omitted flag', {}],
  ])('REJECTS %s rather than guessing the intent', async (_label, body) => {
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req(body), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('404s for a schedule belonging to someone else, without writing', async () => {
    (mockScheduleDb.getScheduleById as any).mockResolvedValue({
      ...PUBLISHING_SCHEDULE,
      userId: 'someone-else',
    });

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), r);

    expect(r.status).toHaveBeenCalledWith(404);
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('404s for a missing schedule', async () => {
    (mockScheduleDb.getScheduleById as any).mockResolvedValue(null);
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);
    expect(r.status).toHaveBeenCalledWith(404);
  });

  it('500s rather than reporting a change that did not persist', async () => {
    (mockScheduleDb.updateSchedule as any).mockRejectedValue(new Error('throttled'));
    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);
    expect(r.status).toHaveBeenCalledWith(500);
  });
});

describe('ENG-827 — a grant is bound to the tools it was derived from', () => {
  beforeEach(() => jest.clearAllMocks());

  it('conditions the grant on the required tools it just read', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(PUBLISHING_SCHEDULE as any);
    mockScheduleDb.updateSchedule.mockResolvedValue({} as any);

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), r);

    // The scope written is derived from requiredFunctionCalls read a moment earlier,
    // so the write must assert that read still holds.
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ autopublishAuthorized: true }),
      { requiredFunctionCalls: (PUBLISHING_SCHEDULE as any).requiredFunctionCalls }
    );
  });

  it('refuses the grant with 409 when the tools changed underneath it', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(PUBLISHING_SCHEDULE as any);
    const conditionFailed: any = new Error('The conditional request failed');
    conditionFailed.code = 'ConditionalCheckFailedException';
    mockScheduleDb.updateSchedule.mockRejectedValue(conditionFailed);

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), r);

    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json.mock.calls[0][0].error).toMatch(/changed while you were authorizing/i);
  });

  it('does NOT condition a revoke — narrowing must always be available', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(PUBLISHING_SCHEDULE as any);
    mockScheduleDb.updateSchedule.mockResolvedValue({} as any);

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: false }), r);

    // Failing a revoke because something else changed would be a refusal to take a
    // permission away, which is the one direction that must never be blocked.
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith(
      SCHEDULE_ID,
      expect.objectContaining({ autopublishAuthorized: false }),
      undefined
    );
  });

  it('still surfaces a non-condition write failure as a 500', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(PUBLISHING_SCHEDULE as any);
    mockScheduleDb.updateSchedule.mockRejectedValue(new Error('DynamoDB is down'));

    const r = res();
    await agentModeController.revokeScheduledChatPublishConsent(req({ authorized: true }), r);

    expect(r.status).toHaveBeenCalledWith(500);
  });
});
