// Unit tests for CRM sender-phones endpoints

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

import express from 'express';
import request from 'supertest';
import { settingsService } from '../services/settingsService';
import router from '../routes/crm';

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    createLeadList: jest.fn(),
    getLeadListById: jest.fn(),
    updateLeadList: jest.fn(),
    deleteLeadList: jest.fn(),
    getLeadsByListId: jest.fn(),
    createLead: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn(),
    deleteLead: jest.fn(),
    batchCreateLeads: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { generateResponse: jest.fn(), searchWeb: jest.fn() },
}));

jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(),
}));

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: { getEventsByLeadEmail: jest.fn(), getEventsByEmailDomain: jest.fn(), getEventsByEmailDomainAndLeadEmail: jest.fn() },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com' };
    next();
  },
  AuthenticatedRequest: {},
}));

const mockedGetSetting = settingsService.getSetting as jest.MockedFunction<typeof settingsService.getSetting>;
const mockedSetSetting = settingsService.setSetting as jest.MockedFunction<typeof settingsService.setSetting>;

const TEST_USER_ID = 'user-123';
const TEST_USER_EMAIL = 'test@example.com';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/crm', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── GET /api/crm/sender-phones ───────────────────────────────────────────────

describe('GET /api/crm/sender-phones', () => {
  it('returns empty senders when no config exists', async () => {
    mockedGetSetting.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/crm/sender-phones');
    expect(res.status).toBe(200);
    expect(res.body.senders).toEqual([]);
    expect(res.body.defaultSenderId).toBeNull();
  });

  it('returns saved senders when config exists', async () => {
    const config = {
      senders: [{ id: '0', phoneNumber: '+12065550001', displayName: 'John from Acme' }],
      defaultSenderId: '0',
    };
    mockedGetSetting.mockResolvedValue({
      settingName: `crm_sender_phones_${TEST_USER_ID}`,
      settingValue: JSON.stringify(config),
      updatedAt: new Date().toISOString(),
      updatedBy: TEST_USER_EMAIL,
    });

    const res = await request(makeApp()).get('/api/crm/sender-phones');
    expect(res.status).toBe(200);
    expect(res.body.senders).toHaveLength(1);
    expect(res.body.senders[0].phoneNumber).toBe('+12065550001');
    expect(res.body.defaultSenderId).toBe('0');
  });

  it('returns empty on corrupt JSON in settings', async () => {
    mockedGetSetting.mockResolvedValue({
      settingName: `crm_sender_phones_${TEST_USER_ID}`,
      settingValue: '{invalid json',
      updatedAt: new Date().toISOString(),
      updatedBy: TEST_USER_EMAIL,
    });

    const res = await request(makeApp()).get('/api/crm/sender-phones');
    expect(res.status).toBe(200);
    expect(res.body.senders).toEqual([]);
  });
});

// ─── POST /api/crm/sender-phones ─────────────────────────────────────────────

describe('POST /api/crm/sender-phones', () => {
  it('saves valid sender successfully', async () => {
    mockedSetSetting.mockResolvedValue({ settingName: 'x', settingValue: '{}', updatedAt: '', updatedBy: '' } as any);
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({
        senders: [{ phoneNumber: '+12065550001', displayName: 'John from Acme' }],
        defaultSenderId: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.senders).toHaveLength(1);
    expect(res.body.senders[0].phoneNumber).toBe('+12065550001');
    expect(res.body.senders[0].displayName).toBe('John from Acme');
    expect(mockedSetSetting).toHaveBeenCalledWith(
      `crm_sender_phones_${TEST_USER_ID}`,
      expect.any(String),
      'CRM SMS sender phones configuration',
      TEST_USER_EMAIL
    );
  });

  it('rejects sender missing displayName', async () => {
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({ senders: [{ phoneNumber: '+12065550001' }], defaultSenderId: null });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/displayName/);
  });

  it('rejects sender missing phoneNumber', async () => {
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({ senders: [{ displayName: 'John' }], defaultSenderId: null });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/phoneNumber/);
  });

  it('rejects invalid phone number format (not E.164)', async () => {
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({
        senders: [{ phoneNumber: '2065550001', displayName: 'John' }],
        defaultSenderId: null,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/E\.164/);
  });

  it('rejects non-array senders body', async () => {
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({ senders: 'not-an-array', defaultSenderId: null });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/array/i);
  });

  it('rejects invalid defaultSenderId', async () => {
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({
        senders: [{ phoneNumber: '+12065550001', displayName: 'John' }],
        defaultSenderId: 'nonexistent-id',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/defaultSenderId/);
  });

  it('auto-assigns first sender as default when defaultSenderId is null', async () => {
    mockedSetSetting.mockResolvedValue({ settingName: 'x', settingValue: '{}', updatedAt: '', updatedBy: '' } as any);
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({
        senders: [{ phoneNumber: '+12065550001', displayName: 'John' }],
        defaultSenderId: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.defaultSenderId).toBeDefined();
  });

  it('saves optional notes field', async () => {
    mockedSetSetting.mockResolvedValue({ settingName: 'x', settingValue: '{}', updatedAt: '', updatedBy: '' } as any);
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({
        senders: [{ phoneNumber: '+12065550001', displayName: 'John', notes: 'My Calendly link' }],
        defaultSenderId: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.senders[0].notes).toBe('My Calendly link');
  });

  it('saves empty senders array', async () => {
    mockedSetSetting.mockResolvedValue({ settingName: 'x', settingValue: '{}', updatedAt: '', updatedBy: '' } as any);
    const res = await request(makeApp())
      .post('/api/crm/sender-phones')
      .send({ senders: [], defaultSenderId: null });

    expect(res.status).toBe(200);
    expect(res.body.senders).toEqual([]);
    expect(res.body.defaultSenderId).toBeNull();
  });
});
