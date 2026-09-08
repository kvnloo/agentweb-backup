/**
 * ENG-493: Express never configured `trust proxy`, so behind the real prod topology
 * (ALB -> nginx -> Node over loopback), `req.ip` collapsed to the loopback address for
 * EVERY caller instead of the real client IP carried in `X-Forwarded-For`.
 *
 * This imports the REAL app (not a rebuilt test app) so it exercises the actual
 * configuration in app.ts, and drives it through supertest exactly the way nginx does in
 * prod: the socket stays loopback, and X-Forwarded-For carries "<client-ip>, <nginx's own
 * connecting address>" (nginx appends via $proxy_add_x_forwarded_for; confirmed against a
 * live prod nginx access log — see ENG-493).
 *
 * Uses the pre-existing auth rate limiter (routes/auth.ts, keyed by the default `req.ip`)
 * as the observable. Without `trust proxy` set, Express ignores X-Forwarded-For entirely
 * and `req.ip` is always the loopback socket address — so express-rate-limit's default
 * keyGenerator produces the SAME key for every distinct real caller, merging all of their
 * budgets into one shared global bucket (one caller's traffic can exhaust everyone else's
 * quota). With `trust proxy` correctly configured for the ALB -> nginx hop count,
 * `req.ip` resolves to the real client IP and each caller gets an independent budget.
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

// Mirrors the real chain: ALB sets X-Forwarded-For to the real client, nginx appends its
// own connecting address ($proxy_add_x_forwarded_for) before proxying to Node over
// loopback. Two distinct internal ALB nodes were observed in prod, both unique per client.
const asRealCaller = (clientIp: string) => `${clientIp}, 172.31.0.31`;

describe('ENG-493: trust proxy is configured for the real ALB -> nginx -> Node topology', () => {
  it('app.ts sets a numeric trust proxy hop count (not the false default)', () => {
    expect(app.get('trust proxy')).toBe(2);
  });

  it('tracks separate real callers independently instead of one shared global bucket', async () => {
    // Exhaust the 10-request/15-min budget for one real client.
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', asRealCaller('34.105.84.37'))
        .send({});
      expect(res.status).toBe(400);
    }
    const exhausted = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', asRealCaller('34.105.84.37'))
      .send({});
    expect(exhausted.status).toBe(429);

    // A completely different real caller must be unaffected.
    const otherCaller = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', asRealCaller('203.0.113.9'))
      .send({});
    expect(otherCaller.status).toBe(400);
  });
});
