/**
 * ENG-493: routes/waitlist.ts's public signup rate limiter (`waitlist-signup:${req.ip}`,
 * 5/minute) is a third consumer of the same bug — never named in the issue, PR, or review,
 * found separately while sweeping every `req.ip` call site for second-order effects. Like the
 * lead-magnet endpoint, it had zero coverage proving distinct real callers get independent
 * budgets rather than one shared global bucket.
 *
 * Imports the real app and drives it through supertest with the same ALB+nginx
 * X-Forwarded-For shape as trustProxy.test.ts / leadMagnetTrustProxy.test.ts.
 *
 * The underlying `rateLimiter` (middleware/rateLimiter.ts) is a module-level singleton with
 * no reset hook, so — unlike the lead-magnet tests, which clear an exported Map between
 * cases — each test here uses its own distinct client IPs to stay isolated rather than
 * depending on shared state being cleared.
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

// Mirrors the real chain: ALB sets X-Forwarded-For to the real client, nginx appends its own
// connecting address ($proxy_add_x_forwarded_for) before proxying to Node over loopback.
const asRealCaller = (clientIp: string) => `${clientIp}, 172.31.0.31`;

describe('ENG-493: waitlist signup rate limiter sees the real client through trust proxy', () => {
  it('tracks separate real callers independently instead of one shared global bucket', async () => {
    // Exhaust the 5-request/minute IP budget for one real client.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/waitlist')
        .set('X-Forwarded-For', asRealCaller('45.253.245.24'))
        .send({ email: `waitlist-a-${i}@example.com` });
      expect(res.status).not.toBe(429);
    }
    const exhausted = await request(app)
      .post('/api/waitlist')
      .set('X-Forwarded-For', asRealCaller('45.253.245.24'))
      .send({ email: 'waitlist-a-overflow@example.com' });
    expect(exhausted.status).toBe(429);
    expect(exhausted.body.message).toMatch(/too many requests/i);

    // A completely different real caller must be unaffected by client-a's exhausted budget.
    const otherCaller = await request(app)
      .post('/api/waitlist')
      .set('X-Forwarded-For', asRealCaller('203.0.113.10'))
      .send({ email: 'waitlist-b@example.com' });
    expect(otherCaller.status).not.toBe(429);
  });

  it('keys off the real client, not an attacker-prepended leftmost XFF entry', async () => {
    // AWS ALB appends to (rather than overwrites) a client-supplied X-Forwarded-For, so an
    // attacker can prepend an arbitrary leftmost entry. With the correct hop count, Express
    // must resolve req.ip to the real client in the middle, not the spoofed leftmost value.
    const realClient = '34.105.84.38';
    const spoofedXff = (spoofed: string) => `${spoofed}, ${realClient}, 172.31.0.31`;

    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/api/waitlist')
        .set('X-Forwarded-For', spoofedXff('1.1.1.1'))
        .send({ email: `waitlist-spoof-${i}@example.com` });
      expect(res.status).not.toBe(429);
    }
    const exhausted = await request(app)
      .post('/api/waitlist')
      .set('X-Forwarded-For', spoofedXff('1.1.1.1'))
      .send({ email: 'waitlist-spoof-overflow@example.com' });
    expect(exhausted.status).toBe(429);

    // A different spoofed leftmost value with the SAME real client must still hit the same
    // exhausted bucket — proving the key is the real client, not the attacker-controlled value.
    const sameClientDifferentSpoof = await request(app)
      .post('/api/waitlist')
      .set('X-Forwarded-For', spoofedXff('9.9.9.9'))
      .send({ email: 'waitlist-spoof-another@example.com' });
    expect(sameClientDifferentSpoof.status).toBe(429);
  });
});
