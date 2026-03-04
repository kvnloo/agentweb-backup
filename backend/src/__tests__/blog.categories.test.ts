/**
 * Unit tests for GET /api/blog/categories endpoint (getCmsCategories controller)
 */

// Mock secretsManager (used internally by getWebflowConfig)
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
  secretExists: jest.fn(),
}));

// Mock db to provide user info
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

import { Response } from 'express';
import { getSecret, secretExists } from '../utils/secretsManager';
import { userDb } from '../services/db';
import { getCmsCategories } from '../controllers/blog';

const mockResponse = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

const mockRequest = (userId?: string) => {
  return {
    user: userId ? { userId, email: 'test@example.com' } : undefined,
  } as any;
};

describe('getCmsCategories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAIL tests ---

  it('should return 401 when user is not authenticated', async () => {
    const req = mockRequest(); // no userId
    const res = mockResponse();

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) })
    );
  });

  it('should return empty categories when user has no CMS type configured', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-123' });

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        categories: [],
      })
    );
  });

  it('should return empty categories when Webflow config has no categories', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-123', cmsType: 'Webflow' });
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify({
      apiToken: 'token',
      siteId: 'site',
      collectionId: 'col',
    }));

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        cmsType: 'Webflow',
        categories: [],
      })
    );
  });

  it('should handle getWebflowConfig errors gracefully', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-123', cmsType: 'Webflow' });
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockRejectedValue(new Error('Secrets Manager error'));

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('Failed'),
      })
    );
  });

  // --- SUCCESS tests ---

  it('should return category names from Webflow config', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-123', cmsType: 'Webflow' });
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify({
      apiToken: 'token',
      siteId: 'site',
      collectionId: 'col',
      categories: {
        'Technology': 'cat-id-1',
        'Marketing': 'cat-id-2',
        'AI & Machine Learning': 'cat-id-3',
      },
    }));

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBe('Webflow');
    expect(response.categories).toEqual(
      expect.arrayContaining(['Technology', 'Marketing', 'AI & Machine Learning'])
    );
    expect(response.categories).toHaveLength(3);
  });

  it('should return empty categories for non-Webflow CMS types', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-123', cmsType: 'Basehub' });

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        cmsType: 'Basehub',
        categories: [],
      })
    );
  });
});
