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

// ENG-1541 remainder (items 1-2).
const getAccountCapabilityRequirement = jest.fn();
const setAccountCapabilityCorrection = jest.fn();
const isSuppressed = jest.fn();
jest.mock('../services/accountCapabilityRequirementsDb', () => ({
  getAccountCapabilityRequirement: (...a: any[]) => getAccountCapabilityRequirement(...a),
  setAccountCapabilityCorrection: (...a: any[]) => setAccountCapabilityCorrection(...a),
  isSuppressed: (...a: any[]) => isSuppressed(...a),
}));

const recordAdminAudit = jest.fn();
jest.mock('../services/adminAuditLog', () => ({
  recordAdminAudit: (...a: any[]) => recordAdminAudit(...a),
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/adminRenewalIntegrationHealth';

const app = express();
app.use(express.json());
// Stub the real authenticateToken/isAdmin middleware this router is mounted behind in app.ts —
// out of scope for this file (that mount-point wiring isn't this route's own concern), but
// req.user must exist for the /correct handler's audit-log call, same as production.
app.use((req: any, _res, next) => {
  req.user = { userId: 'admin-1', email: 'admin@example.com' };
  next();
});
app.use('/api/admin/renewal-integration-health', router);

beforeEach(() => {
  getUserByIdConsistent.mockReset();
  evaluateRenewalIntegrationHealth.mockReset();
  getAccountCapabilityRequirement.mockReset().mockResolvedValue(null);
  setAccountCapabilityCorrection.mockReset();
  isSuppressed.mockReset().mockReturnValue(false);
  recordAdminAudit.mockReset();
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

/**
 * ENG-1541 remainder (items 1-2). The /evaluate route stayed read-only (verified: it still
 * never calls setAccountCapabilityCorrection), but now also surfaces the persisted row and
 * whether a live would_flag is currently suppressed — the read-surface gap design review found.
 */
describe('/evaluate — capability row + suppression visibility (ENG-1541 remainder)', () => {
  it('includes the capability row in the response when one exists', async () => {
    const user = { userId: 'u1' };
    const capability = { userId: 'u1', capability: 'ad_platform_integration', status: 'unhealthy' };
    getUserByIdConsistent.mockResolvedValue(user);
    evaluateRenewalIntegrationHealth.mockResolvedValue({ decision: 'would_flag' });
    getAccountCapabilityRequirement.mockResolvedValue(capability);

    const res = await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId: 'u1' });

    expect(res.body.capability).toEqual(capability);
  });

  it('reports suppressedByCorrection=true when the live decision is would_flag and isSuppressed says so', async () => {
    getUserByIdConsistent.mockResolvedValue({ userId: 'u1' });
    evaluateRenewalIntegrationHealth.mockResolvedValue({ decision: 'would_flag' });
    isSuppressed.mockReturnValue(true);

    const res = await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId: 'u1' });

    expect(res.body.suppressedByCorrection).toBe(true);
  });

  it('reports suppressedByCorrection=false for a non-would_flag decision, even if isSuppressed would say true — suppression is only meaningful for an actual would_flag', async () => {
    getUserByIdConsistent.mockResolvedValue({ userId: 'u1' });
    evaluateRenewalIntegrationHealth.mockResolvedValue({ decision: 'skipped_healthy_integration' });
    isSuppressed.mockReturnValue(true);

    const res = await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId: 'u1' });

    expect(res.body.suppressedByCorrection).toBe(false);
  });

  it('never writes a correction — stays genuinely read-only', async () => {
    getUserByIdConsistent.mockResolvedValue({ userId: 'u1' });
    evaluateRenewalIntegrationHealth.mockResolvedValue({ decision: 'would_flag' });

    await request(app).post('/api/admin/renewal-integration-health/evaluate').send({ userId: 'u1' });

    expect(setAccountCapabilityCorrection).not.toHaveBeenCalled();
  });
});

describe('/correct — the only place a correction gets written (ENG-1541 remainder)', () => {
  it('400s when userId is omitted', async () => {
    const res = await request(app).post('/api/admin/renewal-integration-health/correct').send({});
    expect(res.status).toBe(400);
    expect(setAccountCapabilityCorrection).not.toHaveBeenCalled();
  });

  it('writes the correction with the authenticated admin as correctedBy, default 30-day lifetime', async () => {
    setAccountCapabilityCorrection.mockResolvedValue(undefined);
    await request(app).post('/api/admin/renewal-integration-health/correct').send({ userId: 'u1' });

    expect(setAccountCapabilityCorrection).toHaveBeenCalledWith(
      'u1', 'ad_platform_integration', 'admin-1', undefined, 30,
    );
  });

  it('passes through an explicit correctionLifetimeDays when given', async () => {
    setAccountCapabilityCorrection.mockResolvedValue(undefined);
    await request(app)
      .post('/api/admin/renewal-integration-health/correct')
      .send({ userId: 'u1', correctionLifetimeDays: 7 });

    expect(setAccountCapabilityCorrection).toHaveBeenCalledWith(
      'u1', 'ad_platform_integration', 'admin-1', undefined, 7,
    );
  });

  it('ignores a non-positive correctionLifetimeDays and falls back to the 30-day default', async () => {
    setAccountCapabilityCorrection.mockResolvedValue(undefined);
    await request(app)
      .post('/api/admin/renewal-integration-health/correct')
      .send({ userId: 'u1', correctionLifetimeDays: -5 });

    expect(setAccountCapabilityCorrection).toHaveBeenCalledWith(
      'u1', 'ad_platform_integration', 'admin-1', undefined, 30,
    );
  });

  it('404s when no tracked row exists for this user — the ConditionalCheckFailedException maps to a real 404, not a silent success or a phantom row', async () => {
    setAccountCapabilityCorrection.mockRejectedValue(
      Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' }),
    );
    const res = await request(app).post('/api/admin/renewal-integration-health/correct').send({ userId: 'nope' });

    expect(res.status).toBe(404);
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });

  it('500s on an unexpected write failure, without leaking the underlying error', async () => {
    setAccountCapabilityCorrection.mockRejectedValue(new Error('boom: token abc123'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/admin/renewal-integration-health/correct').send({ userId: 'u1' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('abc123');
    errSpy.mockRestore();
  });

  it('calls recordAdminAudit with the actor and target after a successful correction — this codebase\'s existing audit pattern, not a bespoke log line', async () => {
    setAccountCapabilityCorrection.mockResolvedValue(undefined);
    await request(app)
      .post('/api/admin/renewal-integration-health/correct')
      .send({ userId: 'u1', correctionNote: 'false positive' });

    expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1',
      actorEmail: 'admin@example.com',
      action: 'renewal_integration_health_correction',
      targetUserId: 'u1',
      correctionNote: 'false positive',
    }));
  });

  it('does not record an audit entry when the write itself fails', async () => {
    setAccountCapabilityCorrection.mockRejectedValue(new Error('boom'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).post('/api/admin/renewal-integration-health/correct').send({ userId: 'u1' });
    expect(recordAdminAudit).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns the fresh capability row after a successful correction', async () => {
    setAccountCapabilityCorrection.mockResolvedValue(undefined);
    const freshRow = { userId: 'u1', capability: 'ad_platform_integration', correctedAt: '2026-01-01' };
    getAccountCapabilityRequirement.mockResolvedValue(freshRow);

    const res = await request(app).post('/api/admin/renewal-integration-health/correct').send({ userId: 'u1' });

    expect(res.status).toBe(200);
    expect(res.body.capability).toEqual(freshRow);
  });
});
