/**
 * ENG-1100 — /api/recap caller-scoped read paths.
 *   AC2: entitled caller only; non-entitled → 403 refusal (not empty success).
 *   AC3: self-service registration signal without isAdmin; the admin route is untouched
 *        (its own admin-gate tests live in crm.registrationStatus.routes.test.ts).
 *   AC4: run results scoped to caller's own schedules; cross-user read fails closed.
 */
const mockGetRegistrationStatusByEmails = jest.fn();
const mockGetSchedulesByUserId = jest.fn();
const mockGetRunResults = jest.fn();
const mockGetUserSubscriptionType = jest.fn();

jest.mock('../services/db', () => ({
  userDb: { getRegistrationStatusByEmails: (...a: any[]) => mockGetRegistrationStatusByEmails(...a) },
  scheduleDb: {
    getSchedulesByUserId: (...a: any[]) => mockGetSchedulesByUserId(...a),
    getRunResults: (...a: any[]) => mockGetRunResults(...a),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: (...a: any[]) => mockGetUserSubscriptionType(...a),
}));

const mockUser: { userId: string; email: string; isAdmin: boolean } = {
  userId: 'user-A',
  email: 'a@example.com',
  isAdmin: false,
};
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = mockUser.userId ? { ...mockUser } : undefined;
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import recapRoutes, { parseSince, projectRunResults } from '../routes/recap';

const app = express();
app.use('/api/recap', recapRoutes);

const ownSchedule = {
  scheduleId: 'sched-A',
  userId: 'user-A',
  name: 'Daily post',
  runResults: [
    { status: 'success', completedAt: '2026-10-01T00:00:00Z', sessionId: 's1', output: 'SECRET-BODY' },
    { status: 'failure', completedAt: '2026-10-05T00:00:00Z', sessionId: 's2' },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockUser.isAdmin = false;
  mockGetUserSubscriptionType.mockResolvedValue('Super Premium');
  mockGetSchedulesByUserId.mockResolvedValue([ownSchedule]);
  mockGetRunResults.mockResolvedValue(ownSchedule.runResults);
});

describe('entitlement (AC2)', () => {
  it.each(['/registration-status', '/scheduled-activity', '/schedules/sched-A/run-results'])(
    '%s refuses a non-entitled caller with 403 and reads nothing',
    async (path) => {
      mockGetUserSubscriptionType.mockResolvedValue('Pro');
      const res = await request(app).get(`/api/recap${path}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('RECAP_NOT_ENTITLED');
      expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
      expect(mockGetSchedulesByUserId).not.toHaveBeenCalled();
      expect(mockGetRunResults).not.toHaveBeenCalled();
    },
  );

  it('rejects unauthenticated callers with 401', async () => {
    mockUser.userId = '';
    const res = await request(app).get('/api/recap/scheduled-activity');
    expect(res.status).toBe(401);
  });
});

describe('self-service registration status (AC3)', () => {
  it('serves a non-admin entitled caller their OWN status, keyed only by their own email', async () => {
    mockGetRegistrationStatusByEmails.mockResolvedValue([
      { email: 'a@example.com', registered: true, isPremium: true, userId: 'user-A' },
    ]);
    const res = await request(app).get('/api/recap/registration-status?email=victim@example.com');
    expect(res.status).toBe(200);
    expect(mockGetRegistrationStatusByEmails).toHaveBeenCalledWith(['a@example.com']);
    expect(res.body.status.registered).toBe(true);
  });

  it('fails closed if the email join resolves a different account', async () => {
    mockGetRegistrationStatusByEmails.mockResolvedValue([
      { email: 'a@example.com', registered: true, isPremium: true, userId: 'user-B' },
    ]);
    const res = await request(app).get('/api/recap/registration-status');
    expect(res.status).toBe(404);
  });
});

describe('scheduled activity (AC4)', () => {
  it('queries only the caller’s schedules and returns a bounded projection', async () => {
    const res = await request(app).get('/api/recap/scheduled-activity?since=2026-10-03T00:00:00Z');
    expect(res.status).toBe(200);
    expect(mockGetSchedulesByUserId).toHaveBeenCalledWith('user-A');
    expect(res.body.schedules).toEqual([
      {
        scheduleId: 'sched-A',
        name: 'Daily post',
        runResults: [{ status: 'failure', at: '2026-10-05T00:00:00Z', sessionId: 's2' }],
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-BODY');
  });

  it('drops any row not owned by the caller even if the index returned it', async () => {
    mockGetSchedulesByUserId.mockResolvedValue([ownSchedule, { ...ownSchedule, scheduleId: 'sched-B', userId: 'user-B' }]);
    const res = await request(app).get('/api/recap/scheduled-activity');
    expect(res.body.schedules.map((s: any) => s.scheduleId)).toEqual(['sched-A']);
  });

  it('cross-user schedule run-results read fails closed with 404 and never reads the row', async () => {
    const res = await request(app).get('/api/recap/schedules/sched-B/run-results');
    expect(res.status).toBe(404);
    expect(mockGetRunResults).not.toHaveBeenCalled();
  });

  it('ENG-2772: foreign schedule id returned by the index still 404s with no data in the body', async () => {
    const foreign = {
      scheduleId: 'sched-B',
      userId: 'user-B',
      name: 'Other tenant',
      runResults: [{ status: 'success', completedAt: '2026-10-02T00:00:00Z', sessionId: 'sB', output: 'FOREIGN-SECRET' }],
    };
    mockGetSchedulesByUserId.mockResolvedValue([ownSchedule, foreign]);
    const res = await request(app).get('/api/recap/schedules/sched-B/run-results');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Schedule not found' });
    const raw = JSON.stringify(res.body);
    for (const leak of ['sched-B', 'user-B', 'Other tenant', 'sB', 'FOREIGN-SECRET']) expect(raw).not.toContain(leak);
    expect(mockGetSchedulesByUserId).toHaveBeenCalledWith('user-A');
    expect(mockGetRunResults).not.toHaveBeenCalled();
  });

  it('own schedule run-results are served', async () => {
    const res = await request(app).get('/api/recap/schedules/sched-A/run-results');
    expect(res.status).toBe(200);
    expect(mockGetRunResults).toHaveBeenCalledWith('sched-A');
    expect(res.body.runResults).toHaveLength(2);
  });

  it('rejects an invalid since with 400', async () => {
    const res = await request(app).get('/api/recap/scheduled-activity?since=yesterday');
    expect(res.status).toBe(400);
  });
});

describe('pure helpers', () => {
  it('parseSince', () => {
    expect(parseSince(undefined)).toEqual({ ok: true, since: null });
    expect(parseSince('nope')).toEqual({ ok: false });
    expect(parseSince('2026-10-01T00:00:00Z')).toEqual({ ok: true, since: Date.parse('2026-10-01T00:00:00Z') });
  });
  it('parseSince rejects impossible calendar dates and timezone-less values', () => {
    expect(parseSince('2026-02-30T00:00:00Z')).toEqual({ ok: false });
    expect(parseSince('2026-10-01T00:00:00')).toEqual({ ok: false });
    expect(parseSince('2026-10-01T00:00:00+05:30')).toEqual({ ok: true, since: Date.parse('2026-10-01T00:00:00+05:30') });
  });
  it('projectRunResults tolerates non-arrays and undated rows under a since bound', () => {
    expect(projectRunResults(undefined, null)).toEqual([]);
    expect(projectRunResults([{ status: 'success' }], 0)).toEqual([]);
  });
});
