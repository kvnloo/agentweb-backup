// Tests for the wizard-style CSV import: preview endpoint + mapping-aware
// import endpoint. The preview endpoint parses headers and sample rows and
// returns a suggested mapping; the import endpoint accepts a columnMapping
// payload that controls how each CSV column is written to the lead.

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn().mockResolvedValue({}),
    batchCreateLeads: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  subscriberDb: { getAllTaskSubscribers: jest.fn() },
  taskDb: { getTaskById: jest.fn() },
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomain: jest.fn(),
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({ agentModeService: { searchWeb: jest.fn() } }));
jest.mock('../utils/llmService', () => ({ createLLMService: jest.fn() }));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', email: 'u@x.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

import { Request, Response } from 'express';
import { crmDb } from '../services/db';
import router from '../routes/crm';

function findRouteHandler(path: string, method: 'post' | 'get' | 'put' | 'delete') {
  const layer = (router as any).stack.find(
    (r: any) => r.route?.path === path && r.route?.methods?.[method],
  );
  if (!layer) return null;
  // Skip multer/middleware layers; pick the actual route handler.
  const handlerLayer = layer.route.stack.find(
    (l: any) => l.name !== 'multerMiddleware' && typeof l.handle === 'function',
  );
  return handlerLayer?.handle || null;
}

function makeReq(overrides: Partial<Request> = {}): any {
  return {
    user: { userId: 'u1', email: 'u@x.com' },
    params: {},
    query: {},
    body: {},
    headers: { 'content-type': 'multipart/form-data' },
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {
    status: jest.fn(function (this: any) { return this; }),
    json: jest.fn(function (this: any) { return this; }),
  };
  return res;
}

describe('CSV Import Wizard endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({
      listId: 'l1',
      userId: 'u1',
      name: 'My List',
    });
  });

  describe('POST /lists/:listId/leads/import/preview', () => {
    it('returns headers, sample rows, and suggestedMapping for known columns', async () => {
      const csv =
        'First Name,Last Name,Email,Co. Linkedin\n' +
        'Jane,Doe,jane@x.com,https://linkedin.com/company/foo\n' +
        'John,Roe,john@x.com,https://linkedin.com/company/bar\n';
      const handler = findRouteHandler('/lists/:listId/leads/import/preview', 'post');
      expect(handler).toBeTruthy();

      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv', mimetype: 'text/csv' } as any,
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());

      const payload = res.json.mock.calls[0][0];
      expect(payload.headers).toEqual(['First Name', 'Last Name', 'Email', 'Co. Linkedin']);
      expect(payload.totalRows).toBe(2);
      expect(payload.sampleRows.length).toBe(2);
      expect(payload.suggestedMapping['First Name'].field).toBe('firstName');
      expect(payload.suggestedMapping['Email'].field).toBe('email');
      expect(payload.suggestedMapping['Co. Linkedin'].field).toBe('companyLinkedin');
    });

    it('echoes savedMapping if list has lastImportMapping', async () => {
      (crmDb.getLeadListById as jest.Mock).mockResolvedValueOnce({
        listId: 'l1',
        userId: 'u1',
        lastImportMapping: { 'Custom Col': 'firstName' },
      });
      const handler = findRouteHandler('/lists/:listId/leads/import/preview', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from('Custom Col\nVal\n'), originalname: 'l.csv' } as any,
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());

      expect(res.json.mock.calls[0][0].savedMapping).toEqual({ 'Custom Col': 'firstName' });
    });

    it('returns 400 when no file provided', async () => {
      const handler = findRouteHandler('/lists/:listId/leads/import/preview', 'post');
      const req = makeReq({ params: { listId: 'l1' }, file: undefined });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('POST /lists/:listId/leads/import — with mapping', () => {
    beforeEach(() => {
      (crmDb.batchCreateLeads as jest.Mock).mockResolvedValue({
        successCount: 1,
        newCount: 1,
        errorCount: 0,
        errors: [],
      });
    });

    it('rejects oversized columnMapping (>500 keys) with 400', async () => {
      const tooManyKeys: Record<string, string> = {};
      for (let i = 0; i < 600; i++) tooManyKeys[`col${i}`] = 'skip';
      tooManyKeys['Email'] = 'email';   // satisfy the email-required gate
      const csv = 'Email\njane@x.com\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: { columnMapping: JSON.stringify(tooManyKeys) },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].message).toMatch(/too many entries|maximum/i);
      expect(crmDb.batchCreateLeads).not.toHaveBeenCalled();
    });

    it('rejects oversized columnMapping (>64KB serialized) with 400', async () => {
      // 50 keys, each holding a 2KB customField name → ~100KB JSON.
      const fat: Record<string, any> = { Email: 'email' };
      const fatKey = 'X'.repeat(2000);
      for (let i = 0; i < 50; i++) fat[`col${i}`] = { customField: `${fatKey}_${i}` };
      const csv = 'Email\njane@x.com\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: { columnMapping: JSON.stringify(fat) },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].message).toMatch(/exceeds.*bytes/i);
    });

    it('rejects import when neither email nor linkedin is mapped', async () => {
      const csv = 'Name Col\nJane\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: { columnMapping: JSON.stringify({ 'Name Col': 'firstName' }) },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
      const msg = res.json.mock.calls[0][0].message;
      expect(msg.toLowerCase()).toContain('email');
    });

    it('skips columns marked as "skip"', async () => {
      const csv = 'Email,Garbage\njane@x.com,xyz\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: {
          columnMapping: JSON.stringify({ Email: 'email', Garbage: 'skip' }),
        },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      expect(crmDb.batchCreateLeads).toHaveBeenCalled();
      const leads = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leads[0].email).toBe('jane@x.com');
      expect(leads[0].customFields?.Garbage).toBeUndefined();
    });

    it('routes columns mapped to a customField directive into customFields', async () => {
      const csv = 'Email,Industry\njane@x.com,Software\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: {
          columnMapping: JSON.stringify({
            Email: 'email',
            Industry: { customField: 'industry' },
          }),
        },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      const leads = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leads[0].customFields?.industry).toBe('Software');
    });

    it('splits a Full Name column into firstName/lastName', async () => {
      const csv = 'Email,Full Name\njane@x.com,Jane Marie Doe\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: {
          columnMapping: JSON.stringify({
            Email: 'email',
            'Full Name': { splitFullName: true },
          }),
        },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      const leads = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leads[0].firstName).toBe('Jane');
      // Everything past the first whitespace-token becomes lastName.
      expect(leads[0].lastName).toBe('Marie Doe');
    });

    it('persists the successful mapping to the LeadList as lastImportMapping', async () => {
      const csv = 'Email\njane@x.com\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const mapping = { Email: 'email' };
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: { columnMapping: JSON.stringify(mapping) },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      expect(crmDb.updateLeadList).toHaveBeenCalledWith(
        'l1',
        expect.objectContaining({ lastImportMapping: mapping }),
      );
    });

    it('falls back to header-name auto-detect when no mapping body is sent (backwards compatible)', async () => {
      const csv = 'email,firstName\njane@x.com,Jane\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: {},
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      const leads = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leads[0].email).toBe('jane@x.com');
      expect(leads[0].firstName).toBe('Jane');
    });

    it('respects companyLinkedin mapping target', async () => {
      const csv = 'Email,Co LinkedIn\njane@x.com,https://linkedin.com/company/foo\n';
      const handler = findRouteHandler('/lists/:listId/leads/import', 'post');
      const req = makeReq({
        params: { listId: 'l1' },
        file: { buffer: Buffer.from(csv), originalname: 'l.csv' } as any,
        body: {
          columnMapping: JSON.stringify({
            Email: 'email',
            'Co LinkedIn': 'companyLinkedin',
          }),
        },
      });
      const res = makeRes();
      await handler!(req as Request, res as Response, jest.fn());
      const leads = (crmDb.batchCreateLeads as jest.Mock).mock.calls[0][1];
      expect(leads[0].companyLinkedin).toBe('https://linkedin.com/company/foo');
    });
  });
});
