import express from 'express';
import request from 'supertest';
import fathomOnboardingAdminRoutes from '../fathomOnboardingAdmin';
import { ingestFathomOnboardingRecording } from '../../services/fathomOnboardingIngestionService';
import { userDb } from '../../services/db';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user', isAdmin: true };
    next();
  }),
}));

jest.mock('../../middleware/admin', () => ({
  isAdmin: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../services/fathomOnboardingIngestionService', () => ({
  ingestFathomOnboardingRecording: jest.fn(),
}));

jest.mock('../../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/admin/fathom-onboarding', fathomOnboardingAdminRoutes);

describe('fathomOnboardingAdminRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ingests a selected Fathom recording through the admin route', async () => {
    (ingestFathomOnboardingRecording as jest.Mock).mockResolvedValue({
      recordingId: '123',
      status: 'reviewed',
      target: { userId: 'target-user', confidence: 'manual' },
      context: { companyName: 'Acme AI' },
    });

    const res = await request(app)
      .post('/api/admin/fathom-onboarding/ingest')
      .send({
        recordingId: '123',
        recordingUrl: 'https://fathom.video/calls/123',
        targetUserId: 'target-user',
        reviewed: true,
        extractedContext: { companyName: 'Acme AI' },
      })
      .expect(200);

    expect(res.body.status).toBe('reviewed');
    expect(ingestFathomOnboardingRecording).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: '123',
      reviewOwnerUserId: 'admin-user',
      targetUserId: 'target-user',
      reviewed: true,
    }));
  });

  it('returns 400 when no recording identifier or URL is supplied', async () => {
    const res = await request(app)
      .post('/api/admin/fathom-onboarding/ingest')
      .send({ extractedContext: { companyName: 'Acme AI' } })
      .expect(400);

    expect(res.body.error).toContain('recordingId or recordingUrl');
    expect(ingestFathomOnboardingRecording).not.toHaveBeenCalled();
  });

  it('surfaces a target user ingestion ledger for review UI', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'target-user',
      fathomOnboardingIngestions: [
        { recordingId: '123', status: 'needs_review', extractionState: 'auto_extracted' },
      ],
    });

    const res = await request(app)
      .get('/api/admin/fathom-onboarding/users/target-user')
      .expect(200);

    expect(res.body.userId).toBe('target-user');
    expect(res.body.ingestions[0]).toMatchObject({
      recordingId: '123',
      status: 'needs_review',
      extractionState: 'auto_extracted',
    });
  });
});
