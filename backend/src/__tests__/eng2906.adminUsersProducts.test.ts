/** ENG-2906 PR2: product attribution on the admin roster (GET /api/admin/users). Mock setup mirrors admin.replayUrls.test.ts. */
import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock the dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
}));
// ENG-1250 AC7: the roster's self-activity signal reads this month's spend from the ledger in one
// batched call. Mocked so these tests never reach a live DynamoDB.
jest.mock('../services/spendProjectionDb', () => ({ getProjectionsBatch: jest.fn() }));
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/resendService', () => ({
  resendService: {
    sendEmail: jest.fn(),
  },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    // ENG-1782 replaced the per-user getSetting loop this file's tests were written
    // against with a single batched getSettings(names) call -- see each test's setup
    // below, which configures getSettings (not getSetting) to match.
    getSettings: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  default: {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
      }),
    })),
  },
  config: {
    update: jest.fn(),
  },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({})),
  },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
    }),
  })),
}));

import { userDb } from '../services/db';
import { settingsService } from '../services/settingsService';
import { getProjectionsBatch } from '../services/spendProjectionDb';

const mockBatch = getProjectionsBatch as jest.Mock;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('GET /api/admin/users — ENG-2906 product attribution', () => {
  const users = [
    {
      userId: 'z1', email: 'z1@test.com', isActive: true, createdAt: '2026-01-01',
      signupProduct: 'zoma', signupClient: 'zoma_device', signupRef: 'hn', attributionConfidence: 'tracked',
      signupPath: 'zoma_device', signupSource: 'mcp',
      products: { zoma: { firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-02T00:00:00Z' } },
      zomaStage: 'first_read', zomaStageAt: '2026-01-02T00:00:00Z',
    },
    {
      userId: 'm1', email: 'm1@test.com', isActive: true, createdAt: '2026-01-01',
      signupProduct: 'emma_web',
      products: { emma_web: { firstAt: 'a', lastAt: 'b' }, emma_mcp: { firstAt: 'a', lastAt: 'b' } },
    },
    { userId: 'w1', email: 'w1@test.com', isActive: true, createdAt: '2026-01-01' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockBatch.mockResolvedValue(new Map());
    mockSettingsService.getSettings.mockResolvedValue([]);
    mockUserDb.getAllUsers.mockResolvedValue(users as any);
  });

  it('returns the product attribution fields on each row', async () => {
    const res = await request(app).get('/api/admin/users').expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toMatchObject({
      signupProduct: 'zoma',
      products: { zoma: { firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-01-02T00:00:00Z' } },
      zomaStage: 'first_read',
      zomaStageAt: '2026-01-02T00:00:00Z',
      signupClient: 'zoma_device',
      signupRef: 'hn',
      attributionConfidence: 'tracked',
    });
  });

  it('product=zoma keeps users with products.zoma or signupProduct zoma', async () => {
    const res = await request(app).get('/api/admin/users?product=zoma').expect(200);
    expect(res.body.map((u: any) => u.userId)).toEqual(['z1']);
  });

  it('product=emma_mcp matches the products map even when the signup was web', async () => {
    const res = await request(app).get('/api/admin/users?product=emma_mcp').expect(200);
    expect(res.body.map((u: any) => u.userId)).toEqual(['m1']);
  });

  it('product=emma_web matches signupProduct/products only (no attribution is not web)', async () => {
    const res = await request(app).get('/api/admin/users?product=emma_web').expect(200);
    expect(res.body.map((u: any) => u.userId)).toEqual(['m1']);
  });

  it('rejects an unknown or repeated product with 400 and never reads users', async () => {
    await request(app).get('/api/admin/users?product=unknown').expect(400);
    await request(app).get('/api/admin/users?product=ZOMA').expect(400);
    await request(app).get('/api/admin/users?product=zoma&product=emma_mcp').expect(400);
    expect(mockUserDb.getAllUsers).not.toHaveBeenCalled();
  });
});
