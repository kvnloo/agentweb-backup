import express from 'express';
import request from 'supertest';

// ENG-2406: company lead assign/unassign must verify the caller may edit listId.

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: req.headers['x-test-user'] };
    next();
  },
}));

const mockGetCompany = jest.fn();
const mockAssign = jest.fn();
const mockUnassign = jest.fn();
jest.mock('../../services/companyDb', () => ({
  companyDb: {
    getCompany: (...a: any[]) => mockGetCompany(...a),
    assignLeadToCompany: (...a: any[]) => mockAssign(...a),
    unassignLeadFromCompany: (...a: any[]) => mockUnassign(...a),
  },
  COMPANY_DEAL_STAGES: [],
  CompanyNotFoundError: class extends Error {},
  CompanyAuthError: class extends Error {},
}));

const mockGetList = jest.fn();
jest.mock('../../services/db', () => ({
  crmDb: { getLeadListById: (...a: any[]) => mockGetList(...a) },
}));

const mockCanAccess = jest.fn();
jest.mock('../../services/crmAccessControl', () => ({
  canAccessCrmList: (...a: any[]) => mockCanAccess(...a),
}));

import crmCompaniesRouter from '../crmCompanies';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/crm/companies', crmCompaniesRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Company co-B is owned by user B; list-A is owned by user A.
  mockGetCompany.mockResolvedValue({ companyId: 'co-B', userId: 'user-B' });
  mockGetList.mockImplementation(async (id: string) =>
    id === 'list-A' ? { listId: 'list-A', userId: 'user-A' } :
    id === 'list-B' ? { listId: 'list-B', userId: 'user-B' } : null);
  mockCanAccess.mockImplementation(async (uid: string, list: any) => list.userId === uid);
  mockAssign.mockResolvedValue(undefined);
  mockUnassign.mockResolvedValue(undefined);
});

describe('POST /:companyId/leads', () => {
  it('rejects user B assigning a lead in user A list without writing', async () => {
    const res = await request(makeApp())
      .post('/api/crm/companies/co-B/leads')
      .set('x-test-user', 'user-B')
      .send({ listId: 'list-A', leadId: 'lead-1' });
    expect(res.status).toBe(404);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('rejects an unknown list without writing', async () => {
    const res = await request(makeApp())
      .post('/api/crm/companies/co-B/leads')
      .set('x-test-user', 'user-B')
      .send({ listId: 'nope', leadId: 'lead-1' });
    expect(res.status).toBe(404);
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('owner path returns 204', async () => {
    const res = await request(makeApp())
      .post('/api/crm/companies/co-B/leads')
      .set('x-test-user', 'user-B')
      .send({ listId: 'list-B', leadId: 'lead-1' });
    expect(res.status).toBe(204);
    expect(mockAssign).toHaveBeenCalledWith('list-B', 'lead-1', 'co-B');
  });
});

describe('DELETE /:companyId/leads/:leadId', () => {
  it('rejects user B unassigning a lead in user A list without writing', async () => {
    const res = await request(makeApp())
      .delete('/api/crm/companies/co-B/leads/lead-1?listId=list-A')
      .set('x-test-user', 'user-B');
    expect(res.status).toBe(404);
    expect(mockUnassign).not.toHaveBeenCalled();
  });

  it('owner path returns 204', async () => {
    const res = await request(makeApp())
      .delete('/api/crm/companies/co-B/leads/lead-1?listId=list-B')
      .set('x-test-user', 'user-B');
    expect(res.status).toBe(204);
    expect(mockUnassign).toHaveBeenCalledWith('list-B', 'lead-1');
  });
});
