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

import express from 'express';
import request from 'supertest';

const { waitlistDb } = require('../services/waitlistDb');
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;

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

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('GET /api/waitlist — admin-only', () => {
    it('returns 401 for an anonymous request (no token)', async () => {
      const res = await request(app).get('/api/waitlist');
      expect(res.status).toBe(401);
      expect(mockWaitlistDb.list).not.toHaveBeenCalled();
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
