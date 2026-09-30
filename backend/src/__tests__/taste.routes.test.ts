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
  deleteProfile: jest.fn(),
};

jest.mock('../services/tasteProfileService', () => {
  const actual = jest.requireActual('../services/tasteProfileService');
  return {
    ...actual,
    tasteProfileService: mockTasteProfileService,
  };
});

import tasteRoutes from '../routes/taste';
import {
  MAX_TASTE_ITEMS,
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
