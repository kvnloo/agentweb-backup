import express from 'express';
import request from 'supertest';

let currentUser: any = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = currentUser; next(); },
}));
jest.mock('../../middleware/admin', () => ({
  isAdmin: (req: any, res: any, next: any) => req.user?.isAdmin ? next() : res.status(403).json({ message: 'admin required' }),
}));
jest.mock('../../services/clientAllowanceAdminService', () => ({
  ClientAllowanceError: class ClientAllowanceError extends Error { constructor(public code: string, message: string) { super(message); } },
  inspectClientAllowance: jest.fn(),
  changeClientSubscription: jest.fn(),
  grantClientCostCredit: jest.fn(),
}));

import routes from '../clientAllowanceAdmin';
import { changeClientSubscription, grantClientCostCredit, inspectClientAllowance } from '../../services/clientAllowanceAdminService';

describe('client allowance admin routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', routes);
  const inspect = inspectClientAllowance as jest.Mock;
  const change = changeClientSubscription as jest.Mock;
  const grantCredit = grantClientCostCredit as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    currentUser = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
  });

  it('returns a redacted allowance snapshot to an admin', async () => {
    inspect.mockResolvedValue({ email: 'client@example.com', effectiveAllowance: 125, blocked: false });
    await request(app).get('/api/admin/client-allowance?email=client@example.com').expect(200, {
      email: 'client@example.com', effectiveAllowance: 125, blocked: false,
    });
    expect(inspect).toHaveBeenCalledWith('client@example.com', expect.any(Object));
  });

  it('does not let non-admin callers enumerate client allowance', async () => {
    currentUser = { userId: 'member-1', isAdmin: false };
    await request(app).get('/api/admin/client-allowance?email=client@example.com').expect(403);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects an unconfirmed mutation before it reaches the service', async () => {
    await request(app).post('/api/admin/client-allowance/subscription').send({
      email: 'client@example.com', subscriptionType: 'Pro', reason: 'Support correction',
    }).expect(400);
    expect(change).not.toHaveBeenCalled();
  });

  it('passes a confirmed mutation and authenticated actor to the service', async () => {
    change.mockResolvedValue({ changed: true });
    await request(app).post('/api/admin/client-allowance/subscription').send({
      email: 'client@example.com', subscriptionType: 'Pro', reason: 'Support correction', confirmed: true,
    }).expect(200, { changed: true });
    expect(change).toHaveBeenCalledWith(expect.objectContaining({
      email: 'client@example.com', subscriptionType: 'Pro', reason: 'Support correction',
      actor: { userId: 'admin-1', email: 'admin@example.com' },
    }), expect.any(Object));
  });

  it('requires confirmation for a cost credit and forwards its idempotency key', async () => {
    await request(app).post('/api/admin/client-allowance/cost-credit').send({
      email: 'client@example.com', amountUsd: 2.5, reason: 'Support correction', idempotencyKey: 'support-20260823',
    }).expect(400);
    expect(grantCredit).not.toHaveBeenCalled();

    grantCredit.mockResolvedValue({ granted: true });
    await request(app).post('/api/admin/client-allowance/cost-credit').send({
      email: 'client@example.com', amountUsd: 2.5, reason: 'Support correction', idempotencyKey: 'support-20260823', confirmed: true,
    }).expect(200, { granted: true });
    expect(grantCredit).toHaveBeenCalledWith(expect.objectContaining({
      amountUsd: 2.5, idempotencyKey: 'support-20260823', actor: { userId: 'admin-1', email: 'admin@example.com' },
    }), expect.any(Object));
  });
});
