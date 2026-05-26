/**
 * Tests for the admin trigger endpoint POST /api/admin/onboarding-loop/trigger.
 *
 * Behavioral contract:
 *   - Returns 202 Accepted with triggeredAt + triggeredBy in the body
 *   - Invokes runOnboardingLoop() exactly once per request
 *   - Does NOT await the run (the loop takes 30-90s; we return immediately)
 *   - If runOnboardingLoop rejects in the background, the 202 still goes
 *     out and the rejection is logged (no unhandled promise rejection)
 *
 * Auth is enforced by middleware mounted in app.ts, not in the route file,
 * so the unit test exercises the route in isolation with a stub user.
 */

import express from 'express';
import request from 'supertest';

// Mock runOnboardingLoop before importing the route
const mockRunOnboardingLoop = jest.fn();
jest.mock('../cron/onboardingLoop', () => ({
  runOnboardingLoop: () => mockRunOnboardingLoop(),
}));

import onboardingLoopAdminRoutes from '../routes/onboardingLoopAdmin';

const buildApp = (stubUser?: { userId: string; email: string }) => {
  const app = express();
  app.use(express.json());
  // Simulate authenticateToken populating req.user
  app.use((req, _res, next) => {
    if (stubUser) (req as any).user = stubUser;
    next();
  });
  app.use('/api/admin/onboarding-loop', onboardingLoopAdminRoutes);
  return app;
};

describe('POST /api/admin/onboarding-loop/trigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunOnboardingLoop.mockResolvedValue(undefined);
  });

  it('returns 202 Accepted with triggeredAt timestamp', async () => {
    const app = buildApp({ userId: 'admin-1', email: 'admin@agentweb.pro' });
    const before = new Date().toISOString();
    const res = await request(app).post('/api/admin/onboarding-loop/trigger');
    const after = new Date().toISOString();

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(res.body.triggeredAt >= before).toBe(true);
    expect(res.body.triggeredAt <= after).toBe(true);
  });

  it('returns triggeredBy identity from req.user', async () => {
    const app = buildApp({ userId: 'admin-1', email: 'admin@agentweb.pro' });
    const res = await request(app).post('/api/admin/onboarding-loop/trigger');
    expect(res.body.triggeredBy).toEqual({
      userId: 'admin-1',
      email: 'admin@agentweb.pro',
    });
  });

  it('falls back to "unknown" identity when req.user is absent', async () => {
    const app = buildApp(undefined);
    const res = await request(app).post('/api/admin/onboarding-loop/trigger');
    expect(res.body.triggeredBy).toEqual({ userId: 'unknown', email: 'unknown' });
  });

  it('calls runOnboardingLoop exactly once per request', async () => {
    const app = buildApp({ userId: 'admin-1', email: 'admin@agentweb.pro' });
    await request(app).post('/api/admin/onboarding-loop/trigger');
    expect(mockRunOnboardingLoop).toHaveBeenCalledTimes(1);
  });

  it('does not await the loop — returns before runOnboardingLoop resolves', async () => {
    let resolved = false;
    mockRunOnboardingLoop.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolved = true;
            resolve(undefined);
          }, 200),
        ),
    );

    const app = buildApp({ userId: 'admin-1', email: 'admin@agentweb.pro' });
    const res = await request(app).post('/api/admin/onboarding-loop/trigger');
    expect(res.status).toBe(202);
    // The loop is still pending when the response goes out
    expect(resolved).toBe(false);
  });

  it('does not throw or 500 when runOnboardingLoop rejects in the background', async () => {
    mockRunOnboardingLoop.mockRejectedValue(new Error('LLM down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const app = buildApp({ userId: 'admin-1', email: 'admin@agentweb.pro' });
    const res = await request(app).post('/api/admin/onboarding-loop/trigger');

    expect(res.status).toBe(202);
    // Give the background promise a tick to reject + hit the .catch
    await new Promise((r) => setImmediate(r));
    expect(errSpy).toHaveBeenCalledWith(
      '[onboardingLoopAdmin] Background runOnboardingLoop failed:',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('includes a note pointing to AW-OnboardingLoopRuns for polling completion', async () => {
    const app = buildApp({ userId: 'admin-1', email: 'admin@agentweb.pro' });
    const res = await request(app).post('/api/admin/onboarding-loop/trigger');
    expect(res.body.note).toContain('AW-OnboardingLoopRuns');
  });
});
