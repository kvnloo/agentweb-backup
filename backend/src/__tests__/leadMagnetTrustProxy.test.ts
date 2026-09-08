/**
 * ENG-493: routes/leadMagnet.ts's per-IP rate limiter (5/day) is one of the two consumers the
 * issue itself names as needing verification (its manual-test comment lists both the auth
 * login limiter and this endpoint). trustProxy.test.ts covers the former by importing the
 * real app; this endpoint had no equivalent.
 *
 * The pre-existing leadMagnet.test.ts builds its own bare `express()` app that mounts only
 * leadMagnetRoutes — it never imports app.ts, so `trust proxy` is never in effect there, and
 * its one IP-limit test never varies caller identity (it only proves "N requests from the
 * same test client trip the limit," which would have passed identically before this fix too,
 * since a single unvarying caller collapses to one bucket either way).
 *
 * This imports the REAL app (not a rebuilt test app) and drives it through supertest with the
 * same ALB+nginx X-Forwarded-For shape as trustProxy.test.ts, proving a distinct real caller
 * is NOT blocked by another caller's exhausted IP budget — the actual bug ENG-493 fixes, for
 * the specific endpoint the issue calls out as unverified.
 */
jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
  SES: jest.fn(() => ({})),
}));

import request from 'supertest';
import app from '../app';
import { dailyEmailTracker, dailyIpTracker } from '../routes/leadMagnet';

// Mirrors the real chain: ALB sets X-Forwarded-For to the real client, nginx appends its own
// connecting address ($proxy_add_x_forwarded_for) before proxying to Node over loopback.
const asRealCaller = (clientIp: string) => `${clientIp}, 172.31.0.31`;

describe('ENG-493: lead-magnet IP rate limiter sees the real client through trust proxy', () => {
  beforeEach(() => {
    dailyEmailTracker.clear();
    dailyIpTracker.clear();
  });

  it('tracks separate real callers independently instead of one shared global bucket', async () => {
    // Exhaust the 5-request/day IP budget for one real client. Distinct emails per request so
    // the 1/day EMAIL limit (checked first) never masks the IP limit under test.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .set('X-Forwarded-For', asRealCaller('45.253.245.23'))
        .send({ email: `client-a-${i}@example.com`, taskInput: 'Test task' });
      expect(res.status).not.toBe(429);
    }
    const exhausted = await request(app)
      .post('/api/lead-magnet/execute')
      .set('X-Forwarded-For', asRealCaller('45.253.245.23'))
      .send({ email: 'client-a-overflow@example.com', taskInput: 'Test task' });
    expect(exhausted.status).toBe(429);
    expect(exhausted.body.message).toMatch(/too many requests/i);

    // A completely different real caller must be unaffected by client-a's exhausted budget.
    const otherCaller = await request(app)
      .post('/api/lead-magnet/execute')
      .set('X-Forwarded-For', asRealCaller('203.0.113.9'))
      .send({ email: 'client-b@example.com', taskInput: 'Test task' });
    expect(otherCaller.status).not.toBe(429);
  });

  it('keys off the real client, not an attacker-prepended leftmost XFF entry', async () => {
    // AWS ALB appends to (rather than overwrites) a client-supplied X-Forwarded-For, so an
    // attacker can prepend an arbitrary leftmost entry. With the correct hop count, Express
    // must resolve req.ip to the real client in the middle, not the spoofed leftmost value.
    const realClient = '34.105.84.37';
    const spoofedXff = (spoofed: string) => `${spoofed}, ${realClient}, 172.31.0.31`;

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/lead-magnet/execute')
        .set('X-Forwarded-For', spoofedXff('1.1.1.1'))
        .send({ email: `spoof-${i}@example.com`, taskInput: 'Test task' });
      expect(res.status).not.toBe(429);
    }
    const exhausted = await request(app)
      .post('/api/lead-magnet/execute')
      .set('X-Forwarded-For', spoofedXff('1.1.1.1'))
      .send({ email: 'spoof-overflow@example.com', taskInput: 'Test task' });
    expect(exhausted.status).toBe(429);

    // A different spoofed leftmost value with the SAME real client must still hit the same
    // exhausted bucket — proving the key is the real client, not the attacker-controlled value.
    const sameClientDifferentSpoof = await request(app)
      .post('/api/lead-magnet/execute')
      .set('X-Forwarded-For', spoofedXff('9.9.9.9'))
      .send({ email: 'spoof-another@example.com', taskInput: 'Test task' });
    expect(sameClientDifferentSpoof.status).toBe(429);
  });
});
