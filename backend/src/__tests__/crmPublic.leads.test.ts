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

import express from 'express';
import request from 'supertest';
import publicRouter from '../routes/crmPublic';
import { crmDb } from '../services/db';

const app = express();
app.use(express.json());
app.use('/', publicRouter);

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
  beforeEach(() => {
    jest.clearAllMocks();
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(mockList);
    (crmDb.createLead as jest.Mock).mockResolvedValue({ leadId: 'lead_new', ...validBody });
  });

  test('returns 404 when list does not exist', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post('/leads/list_notexist').send(validBody);
    expect(res.status).toBe(404);
  });

  test('returns 403 when list does not have publicAccessEnabled', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ ...mockList, publicAccessEnabled: false });
    const res = await request(app).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(403);
  });

  test('returns 400 when email is missing', async () => {
    const res = await request(app).post('/leads/list_abc123').send({ firstName: 'Jane' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when email is malformed', async () => {
    const res = await request(app).post('/leads/list_abc123').send({ ...validBody, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  test('creates lead and returns 201 on valid request', async () => {
    const res = await request(app).post('/leads/list_abc123').send(validBody);
    expect(res.status).toBe(201);
    expect(crmDb.createLead).toHaveBeenCalledWith('list_abc123', expect.objectContaining({ email: 'test@example.com' }));
    expect(res.body).toHaveProperty('leadId');
  });

  test('strips unknown dangerous fields before creating lead', async () => {
    const res = await request(app).post('/leads/list_abc123').send({
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
});
