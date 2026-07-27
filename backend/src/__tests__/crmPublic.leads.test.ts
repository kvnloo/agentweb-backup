/**
 * Tests for POST /api/crm/public/leads/:listId
 * Public endpoint for landing page lead capture — no auth required.
 */

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    createLead: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  userDb: {},
}));

jest.mock('../services/contactCaptureHooks', () => ({
  onPublicFormSubmitted: jest.fn(),
  onPublicPageVisited: jest.fn(),
}));

jest.mock('../services/contactEventsDb', () => ({
  PUBLIC_LOGGABLE_EVENT_TYPES: new Set(['form.submitted', 'page.visited']),
}));

jest.mock('../services/externalCrmSyncService', () => ({
  externalCrmSyncService: {
    autoSyncLead: jest.fn().mockResolvedValue(undefined),
  },
}));

import express from 'express';
import http from 'http';
import request from 'supertest';
import publicRouter from '../routes/crmPublic';
import { crmDb } from '../services/db';
import { externalCrmSyncService } from '../services/externalCrmSyncService';

const flushAsyncWork = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const app = express();
app.use(express.json());
app.use('/', publicRouter);
let server: http.Server;

const mockList = {
  listId: 'list_abc123',
  name: 'Test List',
  userId: 'user_owner',
  publicAccessEnabled: true,
};

const validBody = {
  email: 'test@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  company: 'Acme Corp',
};

describe('POST /leads/:listId — public lead creation', () => {
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_new', ...validBody });
  });

  test('returns 404 when list does not exist', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    const res = await request(server).post('/leads/list_notexist').send(validBody);
    expect(res.status).toBe(404);
  });

  test('returns 403 when list does not have publicAccessEnabled', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ ...mockList, publicAccessEnabled: false });
    const res = await request(server).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(403);
  });

  test('returns 400 when email is missing', async () => {
    const res = await request(server).post('/leads/list_abc123').send({ firstName: 'Jane' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when email is malformed', async () => {
    const res = await request(server).post('/leads/list_abc123').send({ ...validBody, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('creates lead and returns 201 on valid request', async () => {
    const res = await request(server).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(201);
    expect(crmDb.createLead).toHaveBeenCalledWith('list_abc123', expect.objectContaining({ email: 'test@example.com' }));
    expect(res.body).toHaveProperty('leadId');
  });

  test('strips unknown dangerous fields before creating lead', async () => {
    const res = await request(server).post('/leads/list_abc123').send({
      ...validBody,
      userId: 'hacker',
      listId: 'hacker',
      isAdmin: true,
    });
    expect(res.status).toBe(201);
    const callArgs = (crmDb.createLead as jest.Mock).mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('userId');
    expect(callArgs).not.toHaveProperty('isAdmin');
  });

  test('real-time syncs the new lead to HubSpot and Attio using the list owner userId', async () => {
    const createdLead = { leadId: 'lead_new', ...validBody };
    (crmDb.createLead as jest.Mock).mockResolvedValue(createdLead);

    const res = await request(server).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(201);

    await flushAsyncWork();

    expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledWith(
      'user_owner',
      'list_abc123',
      createdLead,
      'hubspot',
      'created',
    );
    expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalledWith(
      'user_owner',
      'list_abc123',
      createdLead,
      'attio',
      'created',
    );
  });

  test('does not sync to any external CRM when the list rejects the request (403)', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ ...mockList, publicAccessEnabled: false });
    const res = await request(server).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(403);

    await flushAsyncWork();
    expect(externalCrmSyncService.autoSyncLead).not.toHaveBeenCalled();
  });

  test('still returns 201 when external CRM sync rejects (fire-and-forget)', async () => {
    (externalCrmSyncService.autoSyncLead as jest.Mock).mockRejectedValueOnce(new Error('hubspot down'));
    const res = await request(server).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(externalCrmSyncService.autoSyncLead).toHaveBeenCalled();
  });
});
