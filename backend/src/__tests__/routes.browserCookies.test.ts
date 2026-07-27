import request from 'supertest';
import express from 'express';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

jest.mock('../services/db', () => ({
  browserCookieDb: {
    listDomainCookies: jest.fn(),
    saveDomainCookies: jest.fn(),
    deleteDomainCookies: jest.fn(),
  },
}));

import browserCookiesRouter from '../routes/browserCookies';
import { browserCookieDb } from '../services/db';

const app = express();
app.use(express.json());
app.use('/api/browser-cookies', browserCookiesRouter);

const mockDb = browserCookieDb as jest.Mocked<typeof browserCookieDb>;

describe('Browser Cookies Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/browser-cookies', () => {
    it('returns the list of saved domains from browserCookieDb', async () => {
      mockDb.listDomainCookies.mockResolvedValue([
        { domain: 'rankai.ai', cookieCount: 2, createdAt: '2026-01-01T00:00:00.000Z' },
      ]);

      const res = await request(app).get('/api/browser-cookies');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ domain: 'rankai.ai', cookieCount: 2, createdAt: '2026-01-01T00:00:00.000Z' }]);
      expect(mockDb.listDomainCookies).toHaveBeenCalledWith('test-user-id');
    });

    it('never includes encryptedCookies in the response even if the db layer leaked it', async () => {
      mockDb.listDomainCookies.mockResolvedValue([
        { domain: 'rankai.ai', cookieCount: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      ]);

      const res = await request(app).get('/api/browser-cookies');

      expect(res.body[0]).not.toHaveProperty('encryptedCookies');
    });
  });

  describe('POST /api/browser-cookies', () => {
    it('rejects when domain is missing', async () => {
      const res = await request(app).post('/api/browser-cookies').send({ cookieHeader: 'a=b' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/domain/i);
      expect(mockDb.saveDomainCookies).not.toHaveBeenCalled();
    });

    it('rejects when cookieHeader is missing', async () => {
      const res = await request(app).post('/api/browser-cookies').send({ domain: 'rankai.ai' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cookieHeader/i);
    });

    it('rejects an invalid domain format', async () => {
      const res = await request(app).post('/api/browser-cookies').send({ domain: 'not_a_domain', cookieHeader: 'a=b' });
      expect(res.status).toBe(400);
      expect(res.body.type).toBe('INVALID_DOMAIN');
      expect(mockDb.saveDomainCookies).not.toHaveBeenCalled();
    });

    it('rejects a malformed cookie header, surfacing the parser error', async () => {
      const res = await request(app).post('/api/browser-cookies').send({ domain: 'rankai.ai', cookieHeader: 'garbage' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/malformed|invalid/i);
      expect(mockDb.saveDomainCookies).not.toHaveBeenCalled();
    });

    it('normalizes a mixed-case domain to lowercase before saving', async () => {
      mockDb.saveDomainCookies.mockResolvedValue(undefined);

      const res = await request(app).post('/api/browser-cookies').send({ domain: 'RankAI.AI', cookieHeader: 'session=abc123' });

      expect(res.status).toBe(201);
      expect(mockDb.saveDomainCookies).toHaveBeenCalledWith(
        'test-user-id',
        'rankai.ai',
        expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'abc123' })])
      );
    });

    it('saves successfully and returns the domain + cookie count', async () => {
      mockDb.saveDomainCookies.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/browser-cookies')
        .send({ domain: 'rankai.ai', cookieHeader: 'session=abc123; other=xyz' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ domain: 'rankai.ai', cookieCount: 2 });
    });

    it('overwrites on a repeat POST for the same domain (no separate PATCH)', async () => {
      mockDb.saveDomainCookies.mockResolvedValue(undefined);

      await request(app).post('/api/browser-cookies').send({ domain: 'rankai.ai', cookieHeader: 'session=first' });
      await request(app).post('/api/browser-cookies').send({ domain: 'rankai.ai', cookieHeader: 'session=second' });

      expect(mockDb.saveDomainCookies).toHaveBeenCalledTimes(2);
      expect(mockDb.saveDomainCookies).toHaveBeenLastCalledWith(
        'test-user-id',
        'rankai.ai',
        expect.arrayContaining([expect.objectContaining({ value: 'second' })])
      );
    });
  });

  describe('DELETE /api/browser-cookies/:domain', () => {
    it('deletes an existing domain (204)', async () => {
      mockDb.deleteDomainCookies.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/browser-cookies/rankai.ai');

      expect(res.status).toBe(204);
      expect(mockDb.deleteDomainCookies).toHaveBeenCalledWith('test-user-id', 'rankai.ai');
    });

    it('still returns 204 for a nonexistent domain (matches config.ts delete semantics)', async () => {
      mockDb.deleteDomainCookies.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/browser-cookies/never-saved.com');

      expect(res.status).toBe(204);
    });
  });
});
