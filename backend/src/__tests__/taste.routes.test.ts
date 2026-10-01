import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'taste-test-user' };
    next();
  },
}));

const mockTasteProfileService = {
  importXBookmarks: jest.fn(),
  importCollection: jest.fn(),
  getProfile: jest.fn(),
  getApplication: jest.fn(),
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
  applyToPrompt: jest.fn(),
  recordFeedback: jest.fn(),
  listFeedback: jest.fn(),
  reverseFeedback: jest.fn(),
  deleteProfile: jest.fn(),
};

jest.mock('../services/tasteProfileService', () => {
  const actual = jest.requireActual('../services/tasteProfileService');
  return {
    ...actual,
    tasteProfileService: mockTasteProfileService,
  };
});

const mockGetLandingPage = jest.fn();
jest.mock('../services/v0Service', () => ({
  getLandingPage: (...args: any[]) => mockGetLandingPage(...args),
}));

import tasteRoutes from '../routes/taste';
import {
  MAX_TASTE_ITEMS,
  TasteFeedbackNotFoundError,
  TasteProviderError,
  TasteSourceAccessError,
  TasteValidationError,
} from '../services/tasteProfileService';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/taste', tasteRoutes);
  return instance;
}

describe('Taste profile routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('imports X using only the connected account id', async () => {
    mockTasteProfileService.importXBookmarks.mockResolvedValue({
      schema: 'taste.profile.v1',
      itemCount: 12,
    });

    const response = await request(app())
      .post('/api/taste/import/x')
      .send({ accountId: 'account-1' });

    expect(response.status).toBe(201);
    expect(mockTasteProfileService.importXBookmarks)
      .toHaveBeenCalledWith('taste-test-user', 'account-1');
  });

  it('rejects extra credential-shaped fields before calling the service', async () => {
    const field = ['refresh', 'token'].join('_');
    const payload: any = { accountId: 'account-1' };
    payload[field] = 'REDACTED';

    const response = await request(app())
      .post('/api/taste/import/x')
      .send(payload);

    expect(response.status).toBe(400);
    expect(mockTasteProfileService.importXBookmarks).not.toHaveBeenCalled();
  });

  it('rejects oversized collections at the HTTP boundary', async () => {
    const items = Array.from({ length: MAX_TASTE_ITEMS + 1 }, (_, i) => ({ title: `ref-${i}` }));
    const response = await request(app())
      .post('/api/taste/import/collection')
      .send({ items });

    expect(response.status).toBe(400);
    expect(mockTasteProfileService.importCollection).not.toHaveBeenCalled();
  });

  it('does not expose whether a connected X account belongs to someone else', async () => {
    mockTasteProfileService.importXBookmarks.mockRejectedValue(new TasteSourceAccessError());

    const response = await request(app())
      .post('/api/taste/import/x')
      .send({ accountId: 'unknown' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Connected source not found' });
  });

  it('maps validation and provider failures without leaking provider internals', async () => {
    mockTasteProfileService.importCollection.mockRejectedValueOnce(
      new TasteValidationError('items cannot be empty')
    );
    let response = await request(app())
      .post('/api/taste/import/collection')
      .send({ items: [] });
    expect(response.status).toBe(400);

    mockTasteProfileService.importXBookmarks.mockRejectedValueOnce(
      new TasteProviderError('Unable to read bookmarks from the connected X account')
    );
    response = await request(app())
      .post('/api/taste/import/x')
      .send({ accountId: 'account-1' });
    expect(response.status).toBe(502);
    expect(response.body.error).toBe('Unable to read bookmarks from the connected X account');
  });



  it('reads and persists per-surface defaults for the authenticated user', async () => {
    mockTasteProfileService.getSettings.mockResolvedValue({
      schema: 'taste.settings.v1',
      surfaces: { landing_page: 'strong', social: 'subtle', crm: 'off' },
      updatedAt: null,
    });
    mockTasteProfileService.updateSettings.mockResolvedValue({
      schema: 'taste.settings.v1',
      surfaces: { landing_page: 'strong', social: 'strong', crm: 'off' },
      updatedAt: '2026-09-30T12:00:00.000Z',
    });

    const getResponse = await request(app()).get('/api/taste/settings');
    expect(getResponse.status).toBe(200);
    expect(mockTasteProfileService.getSettings).toHaveBeenCalledWith('taste-test-user');

    const putResponse = await request(app())
      .put('/api/taste/settings')
      .send({ surfaces: { social: 'strong' } });
    expect(putResponse.status).toBe(200);
    expect(mockTasteProfileService.updateSettings)
      .toHaveBeenCalledWith('taste-test-user', { social: 'strong' });
  });

  it('lists supported Taste surfaces and intensities', async () => {
    const response = await request(app()).get('/api/taste/surfaces');

    expect(response.status).toBe(200);
    expect(response.body.surfaces).toEqual(expect.arrayContaining([
      'landing_page',
      'image',
      'video',
      'social',
      'ad_creative',
      'research',
      'crm',
    ]));
    expect(response.body.intensities).toEqual(['off', 'subtle', 'strong']);
  });

  it('previews one surface without mutating the profile', async () => {
    mockTasteProfileService.getApplication.mockResolvedValue({
      schema: 'taste.application.v1',
      surface: 'landing_page',
      active: true,
      intensity: 'strong',
    });

    const response = await request(app())
      .get('/api/taste/application')
      .query({ surface: 'landing_page', intensity: 'strong' });

    expect(response.status).toBe(200);
    expect(mockTasteProfileService.getApplication)
      .toHaveBeenCalledWith('taste-test-user', 'landing_page', 'strong');
  });

  it('applies Taste to a prompt with a task-local intensity override', async () => {
    mockTasteProfileService.applyToPrompt.mockResolvedValue({
      prompt: 'Create a hero\n\nTASTE CONTEXT',
      application: { active: true, surface: 'image', intensity: 'subtle' },
    });

    const response = await request(app())
      .post('/api/taste/apply')
      .send({ surface: 'image', intensity: 'subtle', prompt: 'Create a hero' });

    expect(response.status).toBe(200);
    expect(mockTasteProfileService.applyToPrompt)
      .toHaveBeenCalledWith('taste-test-user', 'image', 'Create a hero', 'subtle');
  });

  it('records feedback from the artifact persisted receipt, never caller-supplied provenance', async () => {
    const receipt = {
      schema: 'taste.application-receipt.v1',
      applicationSchema: 'taste.application.v1',
      surface: 'landing_page',
      active: true,
      intensity: 'strong',
      confidence: 0.8,
      resolutionSource: 'surface_default',
      profileRevision: 'profile:v1:0123456789abcdef',
      settingsRevision: 'settings:v1:fedcba9876543210',
      dials: { designVariance: 8, motionIntensity: 4, visualDensity: 5 },
      signals: ['minimal:0.6', 'editorial:0.4'],
      generatedAt: '2026-10-01T06:00:00.000Z',
    };
    mockGetLandingPage.mockResolvedValue({ id: 'page-1', userId: 'taste-test-user', tasteReceipt: receipt });
    mockTasteProfileService.recordFeedback.mockResolvedValue({
      schema: 'taste.feedback.v1',
      eventId: 'event-1',
      artifactType: 'landing_page',
      artifactId: 'page-1',
      direction: 'more',
      receipt,
      createdAt: '2026-10-01T06:01:00.000Z',
    });

    const response = await request(app())
      .post('/api/taste/feedback')
      .send({ artifactType: 'landing_page', artifactId: 'page-1', direction: 'more' });

    expect(response.status).toBe(201);
    expect(mockGetLandingPage).toHaveBeenCalledWith('page-1', 'taste-test-user');
    expect(mockTasteProfileService.recordFeedback).toHaveBeenCalledWith(
      'taste-test-user',
      'landing_page',
      'page-1',
      'more',
      receipt
    );
  });

  it('rejects caller-supplied receipts so provenance cannot be spoofed', async () => {
    const response = await request(app())
      .post('/api/taste/feedback')
      .send({
        artifactType: 'landing_page',
        artifactId: 'page-1',
        direction: 'more',
        receipt: { profileRevision: 'forged' },
      });

    expect(response.status).toBe(400);
    expect(mockGetLandingPage).not.toHaveBeenCalled();
    expect(mockTasteProfileService.recordFeedback).not.toHaveBeenCalled();
  });

  it('does not disclose another user artifact and refuses legacy artifacts without Taste provenance', async () => {
    mockGetLandingPage.mockResolvedValueOnce(null);
    let response = await request(app())
      .post('/api/taste/feedback')
      .send({ artifactType: 'landing_page', artifactId: 'other-user-page', direction: 'less' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Artifact not found' });
    expect(mockTasteProfileService.recordFeedback).not.toHaveBeenCalled();

    mockGetLandingPage.mockResolvedValueOnce({ id: 'legacy-page', userId: 'taste-test-user' });
    response = await request(app())
      .post('/api/taste/feedback')
      .send({ artifactType: 'landing_page', artifactId: 'legacy-page', direction: 'ignore' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'Artifact does not have Taste provenance' });
    expect(mockTasteProfileService.recordFeedback).not.toHaveBeenCalled();
  });

  it('lists feedback for only the authenticated user and reverses by event id', async () => {
    mockTasteProfileService.listFeedback.mockResolvedValue([{ eventId: 'event-1' }]);
    mockTasteProfileService.reverseFeedback.mockResolvedValue({
      eventId: 'event-1',
      reversedAt: '2026-10-01T06:02:00.000Z',
    });

    const listResponse = await request(app())
      .get('/api/taste/feedback')
      .query({ artifactId: 'page-1' });
    expect(listResponse.status).toBe(200);
    expect(mockTasteProfileService.listFeedback)
      .toHaveBeenCalledWith('taste-test-user', 'page-1');

    const reverseResponse = await request(app())
      .post('/api/taste/feedback/event-1/reverse')
      .send({});
    expect(reverseResponse.status).toBe(200);
    expect(mockTasteProfileService.reverseFeedback)
      .toHaveBeenCalledWith('taste-test-user', 'event-1');
  });

  it('maps missing feedback to a tenant-safe 404', async () => {
    mockTasteProfileService.reverseFeedback.mockRejectedValue(
      new TasteFeedbackNotFoundError()
    );

    const response = await request(app())
      .post('/api/taste/feedback/missing/reverse')
      .send({});

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Taste feedback not found' });
  });

  it('returns and deletes the authenticated user profile', async () => {
    mockTasteProfileService.getProfile.mockResolvedValue({
      schema: 'taste.profile.v1',
      sourceCount: 1,
      itemCount: 4,
    });
    mockTasteProfileService.deleteProfile.mockResolvedValue(1);

    const getResponse = await request(app()).get('/api/taste/profile');
    expect(getResponse.status).toBe(200);
    expect(mockTasteProfileService.getProfile).toHaveBeenCalledWith('taste-test-user');

    const deleteResponse = await request(app()).delete('/api/taste/profile');
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body).toEqual({ success: true, deleted: 1 });
    expect(mockTasteProfileService.deleteProfile).toHaveBeenCalledWith('taste-test-user');
  });
});
