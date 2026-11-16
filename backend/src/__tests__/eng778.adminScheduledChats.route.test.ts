/**
 * ENG-778 AC1-AC6 — admin cross-owner scheduled-chat inspect + pause/resume.
 * Mounted as app.ts does (isAdmin in front), principal stubbed for authenticateToken.
 */
const getScheduleById = jest.fn();
const updateSchedule = jest.fn();
const getUserById = jest.fn();
jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: (...a: any[]) => getScheduleById(...a),
    updateSchedule: (...a: any[]) => updateSchedule(...a),
  },
  userDb: { getUserById: (...a: any[]) => getUserById(...a) },
}));
const recordAdminAudit = jest.fn();
jest.mock('../services/adminAuditLog', () => ({ recordAdminAudit: (...a: any[]) => recordAdminAudit(...a) }));
const isSubscriptionFeatureEnabled = jest.fn();
jest.mock('../services/subscriptionService', () => ({
  isSubscriptionFeatureEnabled: (...a: any[]) => isSubscriptionFeatureEnabled(...a),
}));
const checkScheduleActivationRecipients = jest.fn();
jest.mock('../services/scheduledReportAccess', () => ({
  checkScheduleActivationRecipients: (...a: any[]) => checkScheduleActivationRecipients(...a),
  deliveryEnforcementEnabled: () => true,
  logShadowDecision: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { isAdmin } from '../middleware/admin';
import router from '../routes/adminScheduledChats';

const ADMIN = { userId: 'admin-1', email: 'admin@agentweb.pro', isAdmin: true };
const CUSTOMER = { userId: 'cust-1', email: 'c@x.com', isAdmin: false };

const appAs = (principal: { user?: any; delegateInfo?: any }) => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (principal.user) req.user = principal.user;
    if (principal.delegateInfo) req.delegateInfo = principal.delegateInfo;
    next();
  });
  app.use('/api/admin/scheduled-chats', isAdmin as any, router);
  return app;
};

const schedule = () => ({
  scheduleId: 's-1',
  userId: 'owner-9',
  status: 'active',
  frequency: 'daily',
  nextRunTime: '2026-10-21T00:00:00.000Z',
  emailNotifications: ['founders@agentweb.pro'],
  runResults: new Array(127).fill({ ok: true }),
  startingMessage: 'report',
});

beforeEach(() => {
  jest.clearAllMocks();
  getScheduleById.mockResolvedValue(schedule());
  updateSchedule.mockResolvedValue(undefined);
  getUserById.mockResolvedValue({ userId: 'owner-9', email: 'founders@agentweb.pro' });
  isSubscriptionFeatureEnabled.mockResolvedValue(true);
  checkScheduleActivationRecipients.mockResolvedValue(null);
});

describe('ENG-778 admin scheduled-chat status', () => {
  it('AC1/AC3/AC4: admin pauses a schedule owned by another account; writes only status, conditionally, and audits', async () => {
    const res = await request(appAs({ user: ADMIN })).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'paused' });
    expect(res.status).toBe(200);
    expect(res.body.schedule).toMatchObject({ scheduleId: 's-1', ownerUserId: 'owner-9', status: 'paused', runResultCount: 127 });
    expect(updateSchedule).toHaveBeenCalledTimes(1);
    const [id, updates, expectArg] = updateSchedule.mock.calls[0];
    expect(id).toBe('s-1');
    expect(Object.keys(updates).sort()).toEqual(['status', 'updatedAt']);
    expect(updates.status).toBe('paused');
    expect(expectArg).toEqual({ status: 'active' });
    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'scheduled_chat_status_update',
      actorUserId: 'admin-1',
      scheduleId: 's-1',
      scheduleOwnerUserId: 'owner-9',
      before: 'active',
      after: 'paused',
      at: updates.updatedAt,
    }));
  });

  it('AC1: admin can fetch one schedule by exact ID regardless of owner', async () => {
    const res = await request(appAs({ user: ADMIN })).get('/api/admin/scheduled-chats/s-1');
    expect(res.status).toBe(200);
    expect(res.body.schedule).toMatchObject({ ownerUserId: 'owner-9', status: 'active' });
    getScheduleById.mockResolvedValueOnce(null);
    expect((await request(appAs({ user: ADMIN })).get('/api/admin/scheduled-chats/nope')).status).toBe(404);
  });

  it('AC2: non-admin and delegated-admin sessions are refused before any read or write', async () => {
    for (const p of [{ user: CUSTOMER }, { user: ADMIN, delegateInfo: { isDelegated: true } }, {}]) {
      const app = appAs(p);
      expect((await request(app).get('/api/admin/scheduled-chats/s-1')).status).toBeGreaterThanOrEqual(401);
      expect((await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'paused' })).status).toBeGreaterThanOrEqual(401);
    }
    expect(getScheduleById).not.toHaveBeenCalled();
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it('AC3: only active<->paused; other statuses and invalid inputs are refused without writing', async () => {
    const app = appAs({ user: ADMIN });
    expect((await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'deleted' })).status).toBe(400);
    getScheduleById.mockResolvedValueOnce({ ...schedule(), status: 'inactive' });
    expect((await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'paused' })).status).toBe(409);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('AC6: stale status is refused — caller expectation mismatch and concurrent conditional failure both 409, no audit', async () => {
    const app = appAs({ user: ADMIN });
    const stale = await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'paused', expectedStatus: 'paused' });
    expect(stale.status).toBe(409);
    expect(updateSchedule).not.toHaveBeenCalled();

    updateSchedule.mockRejectedValueOnce(Object.assign(new Error('cond'), { code: 'ConditionalCheckFailedException' }));
    const race = await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'paused' });
    expect(race.status).toBe(409);
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it('no-op when already in the requested status (no write, no audit)', async () => {
    getScheduleById.mockResolvedValueOnce({ ...schedule(), status: 'paused' });
    const res = await request(appAs({ user: ADMIN })).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'paused' });
    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
    expect(updateSchedule).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it('resume applies the owner gates: plan feature and recipient authorization', async () => {
    const app = appAs({ user: ADMIN });
    getScheduleById.mockResolvedValue({ ...schedule(), status: 'paused' });
    isSubscriptionFeatureEnabled.mockResolvedValueOnce(false);
    const planRes = await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'active' });
    expect(planRes.status).toBe(403);
    expect(planRes.body.code).toBe('OWNER_PLAN_LACKS_SCHEDULED_CHATS');
    checkScheduleActivationRecipients.mockResolvedValueOnce({ code: 'no_authorized_recipients', safeAction: 'fix recipients' });
    expect((await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'active' })).status).toBe(400);
    expect(updateSchedule).not.toHaveBeenCalled();

    const ok = await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'active' });
    expect(ok.status).toBe(200);
    expect(updateSchedule.mock.calls[0][2]).toEqual({ status: 'paused' });
    expect(isSubscriptionFeatureEnabled).toHaveBeenCalledWith('owner-9', 'scheduled_chats');
  });

  it('resume refuses an exhausted limited schedule (runCount 0) so it cannot become unlimited', async () => {
    const app = appAs({ user: ADMIN });
    getScheduleById.mockResolvedValue({ ...schedule(), status: 'paused', runCount: 0 });
    const res = await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'active' });
    expect(res.status).toBe(409);
    expect(updateSchedule).not.toHaveBeenCalled();

    getScheduleById.mockResolvedValue({ ...schedule(), status: 'paused', runCount: -1 });
    expect((await request(app).patch('/api/admin/scheduled-chats/s-1/status').send({ status: 'active' })).status).toBe(200);
  });
});
