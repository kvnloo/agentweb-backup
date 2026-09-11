/**
 * ENG-1541 — the read-only dry-run route's input contract and its refusal to
 * leak internal errors or accept an unscoped call.
 */

const getUserByIdConsistent = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserByIdConsistent: (...a: any[]) => getUserByIdConsistent(...a),
  },
}));

const evaluateRenewalIntegrationHealth = jest.fn();
jest.mock('../cron/renewalIntegrationHealthCron', () => ({
  evaluateRenewalIntegrationHealth: (...a: any[]) => evaluateRenewalIntegrationHealth(...a),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/adminRenewalIntegrationHealth';

const app = express();
app.use(express.json());
app.use('/api/admin/renewal-integration-health', router);

beforeEach(() => {
  getUserByIdConsistent.mockReset();
  evaluateRenewalIntegrationHealth.mockReset();
});

describe('invalid input is REJECTED, never silently unscoped', () => {
  it('400s when userId is omitted — this route never runs a fleet-wide scan', async () => {
    const res = await request(app).post('/api/admin/renewal-integration-health/evaluate').send({});
    expect(res.status).toBe(400);
    expect(getUserByIdConsistent).not.toHaveBeenCalled();
  });

  it('400s on a numeric userId', async () => {
    const res = await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId: 42 });
    expect(res.status).toBe(400);
    expect(getUserByIdConsistent).not.toHaveBeenCalled();
  });

  it('400s on an empty / whitespace-only userId', async () => {
    for (const userId of ['', '   ']) {
      const res = await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId });
      expect(res.status).toBe(400);
    }
    expect(getUserByIdConsistent).not.toHaveBeenCalled();
  });
});

describe('valid input', () => {
  it('404s when the user does not exist', async () => {
    getUserByIdConsistent.mockResolvedValue(undefined);
    const res = await request(app)
      .post('/api/admin/renewal-integration-health/evaluate')
      .send({ userId: 'nonexistent' });
    expect(res.status).toBe(404);
    expect(evaluateRenewalIntegrationHealth).not.toHaveBeenCalled();
  });

  it('reads via the strongly-consistent lookup, not the eventually-consistent one', async () => {
    getUserByIdConsistent.mockResolvedValue({ userId: 'u1' });
    evaluateRenewalIntegrationHealth.mockResolvedValue({ decision: 'would_flag' });
    await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId: 'u1' });
    expect(getUserByIdConsistent).toHaveBeenCalledWith('u1');
  });

  it('returns the evaluator result verbatim, never reimplementing the decision itself', async () => {
    const user = { userId: 'u1', email: 'u1@example.com' };
    const evaluation = {
      decision: 'skipped_no_ad_entitlement',
      hasPaidAdsIntent: true,
      hasHealthyAdIntegration: false,
      hasAdIntegrationEntitlement: false,
    };
    getUserByIdConsistent.mockResolvedValue(user);
    evaluateRenewalIntegrationHealth.mockResolvedValue(evaluation);

    const res = await request(app)
      .post('/api/admin/renewal-integration-health/evaluate')
      .send({ userId: 'u1' });

    expect(res.status).toBe(200);
    expect(evaluateRenewalIntegrationHealth).toHaveBeenCalledWith(user);
    expect(res.body.userId).toBe('u1');
    expect(res.body.evaluation).toEqual(evaluation);
    expect(typeof res.body.evaluatedAt).toBe('string');
  });

  it('500s without leaking the underlying error to the caller', async () => {
    getUserByIdConsistent.mockRejectedValue(new Error('boom: token abc123'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/admin/renewal-integration-health/evaluate')
      .send({ userId: 'u1' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('abc123');
    errSpy.mockRestore();
  });
});
