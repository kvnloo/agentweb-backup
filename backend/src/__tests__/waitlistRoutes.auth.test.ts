/**
 * ENG-1753: GET /api/waitlist and PUT /api/waitlist/:email/status were
 * mounted with no auth at all, leaking full waitlist PII (phone, spend) and
 * letting anyone flip a status to "invited". These must now require an
 * authenticated admin. POST / (signup) stays public but rate-limited.
 */

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: {
    add: jest.fn(),
    getByEmail: jest.fn(),
    list: jest.fn(),
    updateStatus: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/zomaAdmission', () => ({
  ...jest.requireActual('../services/zomaAdmission'),
  admitZoma: jest.fn().mockResolvedValue('approved'),
  rejectZoma: jest.fn().mockResolvedValue('rejected'),
  zomaApprovedCount: jest.fn().mockResolvedValue({ approvedCount: 60, capacity: 60 }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { waitlistDb } = require('../services/waitlistDb');
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const { userDb } = require('../services/db');
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const JWT_SECRET = 'test-jwt-secret-for-waitlist-route-tests';

function makeAdminToken(userId = 'admin-1') {
  return jwt.sign({ userId, email: 'admin@example.com', isAdmin: true }, JWT_SECRET);
}

function createApp() {
  const app = express();
  app.use(express.json());
  // Re-require the routes fresh per app so route-level middleware picks up
  // the real (non-mocked) authenticateToken/isAdmin from ../middleware/*.
  const waitlistRoutes = require('../routes/waitlist').default;
  app.use('/api/waitlist', waitlistRoutes);
  return app;
}

describe('Waitlist routes auth (ENG-1753)', () => {
  let app: express.Express;

  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'admin-1',
      email: 'admin@example.com',
      isAdmin: true,
    } as any);
    app = createApp();
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  describe('ENG-2881 capacity administration', () => {
    beforeEach(() => { process.env.ZOMA_WAITLIST_ENABLED = 'true'; });
    afterEach(() => { delete process.env.ZOMA_WAITLIST_ENABLED; });
    it('denies anonymous capacity reads and decisions', async () => {
      expect((await request(app).get('/api/waitlist/zoma/capacity')).status).toBe(401);
      expect((await request(app).post('/api/waitlist/zoma/a@company.co/decision').send({ decision: 'approve' })).status).toBe(401);
    });
    it('denies a non-admin even with a valid token', async () => {
      mockUserDb.getUserById.mockResolvedValue({ userId: 'u1', isAdmin: false, roles: ['customer'] });
      const token = jwt.sign({ userId: 'u1', email: 'u@company.co', isAdmin: false }, JWT_SECRET);
      expect((await request(app).get('/api/waitlist/zoma/capacity').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });
    it('returns count and forwards approve/reject with authenticated actor', async () => {
      const auth = `Bearer ${makeAdminToken()}`;
      const count = await request(app).get('/api/waitlist/zoma/capacity').set('Authorization', auth);
      expect(count.body).toEqual({ approvedCount: 60, capacity: 60 });
      for (const decision of ['approve', 'reject']) {
        const r = await request(app).post('/api/waitlist/zoma/a@company.co/decision').set('Authorization', auth).send({ decision, actor: 'forged' });
        expect(r.status).toBe(200);
      }
      const service = require('../services/zomaAdmission');
      expect(service.admitZoma).toHaveBeenCalledWith('a@company.co', 'admin-1');
      expect(service.rejectZoma).toHaveBeenCalledWith('a@company.co', 'admin-1');
    });
    it('remains dark when flag is disabled', async () => {
      delete process.env.ZOMA_WAITLIST_ENABLED;
      expect((await request(app).get('/api/waitlist/zoma/capacity').set('Authorization', `Bearer ${makeAdminToken()}`)).status).toBe(404);
    });
  });

  describe('GET /api/waitlist — admin-only', () => {
    it('returns 401 for an anonymous request (no token)', async () => {
      const res = await request(app).get('/api/waitlist');
      expect(res.status).toBe(401);
      expect(mockWaitlistDb.list).not.toHaveBeenCalled();
    });

    it('rejects a non-object lastEvaluatedKey before calling waitlistDb.list (ENG-1753 CodeRabbit)', async () => {
      const res = await request(app)
        .get('/api/waitlist')
        .query({ lastEvaluatedKey: '["not", "an", "object"]' })
        .set('Authorization', `Bearer ${makeAdminToken()}`);
      expect(res.status).toBe(400);
      expect(mockWaitlistDb.list).not.toHaveBeenCalled();
    });

    it('rejects a non-JSON lastEvaluatedKey before calling waitlistDb.list', async () => {
      const res = await request(app)
        .get('/api/waitlist')
        .query({ lastEvaluatedKey: 'not-json' })
        .set('Authorization', `Bearer ${makeAdminToken()}`);
      expect(res.status).toBe(400);
      expect(mockWaitlistDb.list).not.toHaveBeenCalled();
    });

    it('accepts a well-formed JSON object lastEvaluatedKey', async () => {
      mockWaitlistDb.list.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
      const res = await request(app)
        .get('/api/waitlist')
        .query({ lastEvaluatedKey: JSON.stringify({ email: 'a@b.com' }) })
        .set('Authorization', `Bearer ${makeAdminToken()}`);
      expect(res.status).toBe(200);
      expect(mockWaitlistDb.list).toHaveBeenCalledWith({ email: 'a@b.com' });
    });
  });

  describe('PUT /api/waitlist/:email/status — admin-only', () => {
    it('returns 401 for an anonymous request (no token)', async () => {
      const res = await request(app)
        .put('/api/waitlist/someone@example.com/status')
        .send({ status: 'invited' });
      expect(res.status).toBe(401);
      expect(mockWaitlistDb.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects an invalid email path param before calling waitlistDb.updateStatus (ENG-1753 CodeRabbit)', async () => {
      const res = await request(app)
        .put('/api/waitlist/not-an-email/status')
        .send({ status: 'invited' })
        .set('Authorization', `Bearer ${makeAdminToken()}`);
      expect(res.status).toBe(400);
      expect(mockWaitlistDb.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/waitlist — public signup stays reachable', () => {
    it('accepts an anonymous signup with a valid email', async () => {
      mockWaitlistDb.getByEmail.mockResolvedValue(null);
      mockWaitlistDb.add.mockResolvedValue({
        email: 'new@example.com',
        joinedAt: new Date().toISOString(),
        status: 'pending',
      });

      const res = await request(app)
        .post('/api/waitlist')
        .send({ email: 'new@example.com' });

      expect(res.status).toBe(201);
      expect(mockWaitlistDb.add).toHaveBeenCalled();
    });

    it('rate-limits repeated anonymous signups from the same IP', async () => {
      mockWaitlistDb.getByEmail.mockResolvedValue(null);
      mockWaitlistDb.add.mockResolvedValue({
        email: 'x@example.com',
        joinedAt: new Date().toISOString(),
        status: 'pending',
      });

      let lastStatus = 0;
      for (let i = 0; i < 10; i++) {
        const res = await request(app)
          .post('/api/waitlist')
          .send({ email: `signup${i}@example.com` });
        lastStatus = res.status;
        if (lastStatus === 429) break;
      }

      expect(lastStatus).toBe(429);
    });
  });
});
