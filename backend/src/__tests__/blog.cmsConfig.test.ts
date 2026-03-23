/**
 * Unit tests for GET/PUT/DELETE /api/blog/cms-config endpoints
 */

// Mock settingsService
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
const mockDeleteSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    deleteSetting: mockDeleteSetting,
  },
  SettingsService: jest.fn(),
}));

// Mock db
const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: mockGetUserById,
    updateUser: mockUpdateUser,
  },
}));

// Mock secretsManager (used by getWordPressConfig/getWebflowConfig)
const mockGetSecret = jest.fn();
const mockSecretExists = jest.fn().mockResolvedValue(false);
jest.mock('../utils/secretsManager', () => ({
  getSecret: mockGetSecret,
  secretExists: mockSecretExists,
}));

import { Response } from 'express';

let getCmsConfig: any;
let saveCmsConfig: any;
let deleteCmsConfig: any;

beforeAll(async () => {
  const blogController = await import('../controllers/blog');
  getCmsConfig = blogController.getCmsConfig;
  saveCmsConfig = blogController.saveCmsConfig;
  deleteCmsConfig = blogController.deleteCmsConfig;
});

const mockResponse = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

const mockRequest = (userId?: string, body?: any) => {
  return {
    user: userId ? { userId, email: 'test@example.com' } : undefined,
    body: body || {},
  } as any;
};

describe('GET /api/blog/cms-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAIL tests ---

  it('should return 401 when user is not authenticated', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await getCmsConfig(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return empty config when no setting exists', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: undefined });
    mockGetSetting.mockResolvedValue(null);

    await getCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBeNull();
    expect(response.config).toEqual({});
  });

  it('should mask applicationPassword in WordPress config', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });
    mockGetSetting.mockResolvedValue({
      settingName: 'cms_config_user-123',
      settingValue: JSON.stringify({
        siteUrl: 'https://example.com',
        username: 'admin',
        applicationPassword: 'abcd EFGH 1234 ijkl',
      }),
    });

    await getCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.config.applicationPassword).toBe('****ijkl');
    expect(response.config.siteUrl).toBe('https://example.com');
    expect(response.config.username).toBe('admin');
  });

  it('should mask apiToken in Webflow config', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'Webflow' });
    mockGetSetting.mockResolvedValue({
      settingName: 'cms_config_user-123',
      settingValue: JSON.stringify({
        apiToken: 'wf_secret_token_12345678',
        siteId: 'site-1',
        collectionId: 'col-1',
      }),
    });

    await getCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.config.apiToken).toBe('****5678');
    expect(response.config.siteId).toBe('site-1');
    expect(response.config.collectionId).toBe('col-1');
  });

  // --- SUCCESS tests ---

  it('should return full config structure for WordPress', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });
    mockGetSetting.mockResolvedValue({
      settingName: 'cms_config_user-123',
      settingValue: JSON.stringify({
        siteUrl: 'https://myblog.com',
        username: 'wp_user',
        applicationPassword: 'xxxx yyyy zzzz',
        categories: { Technology: 3, Marketing: 5 },
      }),
    });

    await getCmsConfig(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBe('WordPress');
    expect(response.config.siteUrl).toBe('https://myblog.com');
    expect(response.config.categories).toEqual({ Technology: 3, Marketing: 5 });
  });

  // --- Secrets Manager fallback tests ---

  it('should fall back to Secrets Manager for WordPress when no AW-Settings config', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });
    mockGetSetting.mockResolvedValue(null); // No AW-Settings
    mockSecretExists.mockResolvedValue(false); // No per-user secret
    mockGetSecret.mockResolvedValue(JSON.stringify({
      siteUrl: 'https://admin-configured.com',
      username: 'admin_user',
      applicationPassword: 'secret-pass-1234',
      categories: { News: 1 },
    }));

    await getCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBe('WordPress');
    expect(response.source).toBe('admin');
    expect(response.config.siteUrl).toBe('https://admin-configured.com');
    expect(response.config.username).toBe('admin_user');
    expect(response.config.applicationPassword).toBe('****1234');
    expect(response.config.categories).toEqual({ News: 1 });
  });

  it('should fall back to Secrets Manager for Webflow when no AW-Settings config', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'Webflow' });
    mockGetSetting.mockResolvedValue(null); // No AW-Settings
    mockSecretExists.mockResolvedValue(false); // No per-user secret
    mockGetSecret.mockResolvedValue(JSON.stringify({
      apiToken: 'wf_long_token_abcd',
      siteId: 'admin-site-1',
      collectionId: 'admin-col-1',
    }));

    await getCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBe('Webflow');
    expect(response.source).toBe('admin');
    expect(response.config.apiToken).toBe('****abcd');
    expect(response.config.siteId).toBe('admin-site-1');
    expect(response.config.collectionId).toBe('admin-col-1');
  });

  it('should return empty config when neither AW-Settings nor Secrets Manager has config', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });
    mockGetSetting.mockResolvedValue(null);
    mockSecretExists.mockResolvedValue(false);
    mockGetSecret.mockRejectedValue(new Error('Secret not found'));

    await getCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.config).toEqual({});
  });

  it('should return source=settings when config is from AW-Settings', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockGetUserById.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });
    mockGetSetting.mockResolvedValue({
      settingName: 'cms_config_user-123',
      settingValue: JSON.stringify({
        siteUrl: 'https://self-configured.com',
        username: 'self_user',
        applicationPassword: 'my-pass-5678',
      }),
    });

    await getCmsConfig(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.source).toBe('settings');
  });
});

describe('PUT /api/blog/cms-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAIL tests ---

  it('should return 401 when user is not authenticated', async () => {
    const req = mockRequest(undefined, { cmsType: 'WordPress' });
    const res = mockResponse();
    await saveCmsConfig(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 400 for invalid cmsType', async () => {
    const req = mockRequest('user-123', { cmsType: 'InvalidCMS', config: {} });
    const res = mockResponse();
    await saveCmsConfig(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('should return 400 when WordPress config missing required fields', async () => {
    const req = mockRequest('user-123', {
      cmsType: 'WordPress',
      config: { siteUrl: 'https://example.com' }, // missing username, applicationPassword
    });
    const res = mockResponse();
    await saveCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.message).toMatch(/username/i);
  });

  it('should return 400 when Webflow config missing required fields', async () => {
    const req = mockRequest('user-123', {
      cmsType: 'Webflow',
      config: { apiToken: 'token' }, // missing siteId, collectionId
    });
    const res = mockResponse();
    await saveCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.message).toMatch(/siteId/i);
  });

  // --- SUCCESS tests ---

  it('should save WordPress config and update cmsType', async () => {
    const config = {
      siteUrl: 'https://myblog.com',
      username: 'admin',
      applicationPassword: 'xxxx yyyy zzzz',
    };
    const req = mockRequest('user-123', { cmsType: 'WordPress', config });
    const res = mockResponse();
    mockUpdateUser.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });

    await saveCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'cms_config_user-123',
      expect.any(String),
      'User CMS configuration',
      'test@example.com'
    );
    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', { cmsType: 'WordPress' });
  });

  it('should save Webflow config and update cmsType', async () => {
    const config = {
      apiToken: 'wf_token_123',
      siteId: 'site-1',
      collectionId: 'col-1',
    };
    const req = mockRequest('user-123', { cmsType: 'Webflow', config });
    const res = mockResponse();
    mockUpdateUser.mockResolvedValue({ userId: 'user-123', cmsType: 'Webflow' });

    await saveCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSetSetting).toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', { cmsType: 'Webflow' });
  });

  it('should clear config when cmsType is null', async () => {
    const req = mockRequest('user-123', { cmsType: null });
    const res = mockResponse();
    mockUpdateUser.mockResolvedValue({ userId: 'user-123', cmsType: null });

    await saveCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDeleteSetting).toHaveBeenCalledWith('cms_config_user-123');
    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', { cmsType: null });
  });

  it('should merge with existing config when password omitted (partial update)', async () => {
    const req = mockRequest('user-123', {
      cmsType: 'WordPress',
      config: {
        siteUrl: 'https://newsite.com',
        username: 'admin',
        // applicationPassword intentionally omitted
      },
    });
    const res = mockResponse();
    // Existing config has password
    mockGetSetting.mockResolvedValue({
      settingName: 'cms_config_user-123',
      settingValue: JSON.stringify({
        siteUrl: 'https://oldsite.com',
        username: 'admin',
        applicationPassword: 'existing-pass',
      }),
    });
    mockUpdateUser.mockResolvedValue({ userId: 'user-123', cmsType: 'WordPress' });

    await saveCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    // Verify the saved config merged the existing password
    const savedJson = mockSetSetting.mock.calls[0][1];
    const savedConfig = JSON.parse(savedJson);
    expect(savedConfig.siteUrl).toBe('https://newsite.com');
    expect(savedConfig.applicationPassword).toBe('existing-pass');
  });
});

describe('DELETE /api/blog/cms-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 when user is not authenticated', async () => {
    const req = mockRequest();
    const res = mockResponse();
    await deleteCmsConfig(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should delete config and clear cmsType', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();
    mockUpdateUser.mockResolvedValue({ userId: 'user-123', cmsType: null });

    await deleteCmsConfig(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockDeleteSetting).toHaveBeenCalledWith('cms_config_user-123');
    expect(mockUpdateUser).toHaveBeenCalledWith('user-123', { cmsType: null });
  });
});
