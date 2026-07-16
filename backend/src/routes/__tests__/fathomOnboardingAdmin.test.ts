import express from 'express';
import request from 'supertest';
import fathomOnboardingAdminRoutes from '../fathomOnboardingAdmin';
import { authenticateToken } from '../../middleware/auth';
import { isAdmin } from '../../middleware/admin';
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
app.use('/api/admin/fathom-onboarding', authenticateToken, isAdmin, fathomOnboardingAdminRoutes);

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

  it('runs automation mode through the admin auto-ingest endpoint without accepting a target user', async () => {
    (ingestFathomOnboardingRecording as jest.Mock).mockResolvedValue({
      recordingId: 'auto-1',
      status: 'needs_review',
      automationState: 'draft_account_created',
      draftUserId: 'fathom-draft-auto-1',
      draftEmail: 'fathom+auto-1@agentweb.internal',
      context: { companyName: 'Auto Co' },
    });

    const res = await request(app)
      .post('/api/admin/fathom-onboarding/auto-ingest')
      .send({
        recordingId: 'auto-1',
        recordingUrl: 'https://fathom.video/calls/auto-1',
        targetUserId: 'attacker-supplied-target',
        extractedContext: {
          callClassification: 'prospect',
          classificationConfidence: 0.9,
          companyName: 'Auto Co',
          website: 'https://auto.co',
          primaryContactEmail: 'buyer@auto.co',
        },
      })
      .expect(200);

    expect(res.body.automationState).toBe('draft_account_created');
    expect(ingestFathomOnboardingRecording).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: 'auto-1',
      reviewOwnerUserId: 'admin-user',
      automationMode: 'auto_draft',
      allowDraftAccountCreation: true,
      reviewed: false,
    }));
    expect(ingestFathomOnboardingRecording).toHaveBeenCalledWith(expect.not.objectContaining({
      targetUserId: 'attacker-supplied-target',
    }));
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
