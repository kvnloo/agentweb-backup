/**
 * Unit tests for WordPress blog publishing integration
 */

// Mock secretsManager
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
  secretExists: jest.fn(),
}));

// Mock db
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

// Mock axios
jest.mock('axios');

import { Response } from 'express';
import { getSecret, secretExists } from '../utils/secretsManager';
import { userDb } from '../services/db';
import { getWordPressConfig, getCmsCategories } from '../controllers/blog';
import axios from 'axios';

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

const VALID_WP_CONFIG = {
  siteUrl: 'https://example.com',
  username: 'admin',
  applicationPassword: 'xxxx xxxx xxxx',
  categories: {
    'Technology': 1,
    'Marketing': 2,
  },
};

describe('getWordPressConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- FAIL tests ---

  it('should throw when secret is missing required fields', async () => {
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify({
      siteUrl: 'https://example.com',
      // missing username and applicationPassword
    }));

    await expect(getWordPressConfig()).rejects.toThrow(
      'WordPress configuration missing required fields'
    );
  });

  it('should throw when secret does not exist', async () => {
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockRejectedValue(new Error('Secret not found'));

    await expect(getWordPressConfig()).rejects.toThrow(
      'Failed to fetch WordPress configuration'
    );
  });

  it('should throw when applicationPassword is missing', async () => {
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify({
      siteUrl: 'https://example.com',
      username: 'admin',
    }));

    await expect(getWordPressConfig()).rejects.toThrow(
      'WordPress configuration missing required fields'
    );
  });

  // --- SUCCESS tests ---

  it('should return valid config from global secret', async () => {
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(VALID_WP_CONFIG));

    const config = await getWordPressConfig();

    expect(config.siteUrl).toBe('https://example.com');
    expect(config.username).toBe('admin');
    expect(config.applicationPassword).toBe('xxxx xxxx xxxx');
    expect(config.categories).toEqual({ Technology: 1, Marketing: 2 });
  });

  it('should prefer per-user secret when available', async () => {
    const userConfig = { ...VALID_WP_CONFIG, siteUrl: 'https://user-site.com' };
    (secretExists as unknown as jest.Mock).mockResolvedValue(true);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(userConfig));

    const config = await getWordPressConfig('user-123');

    expect(config.siteUrl).toBe('https://user-site.com');
    // Verify per-user secret path was checked
    expect(secretExists).toHaveBeenCalledWith(
      expect.stringContaining('/user-123')
    );
  });

  it('should fall back to global secret when per-user secret does not exist', async () => {
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(VALID_WP_CONFIG));

    const config = await getWordPressConfig('user-456');

    expect(config.siteUrl).toBe('https://example.com');
    // Global secret used
    expect(getSecret).toHaveBeenCalledWith(
      expect.not.stringContaining('/user-456')
    );
  });

  it('should strip trailing slashes from siteUrl', async () => {
    const configWithSlash = { ...VALID_WP_CONFIG, siteUrl: 'https://example.com///' };
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(configWithSlash));

    const config = await getWordPressConfig();

    expect(config.siteUrl).toBe('https://example.com');
  });

  it('should parse categories from JSON string', async () => {
    const configWithStringCategories = {
      ...VALID_WP_CONFIG,
      categories: JSON.stringify({ 'Tech': 10, 'News': 20 }),
    };
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(configWithStringCategories));

    const config = await getWordPressConfig();

    expect(config.categories).toEqual({ Tech: 10, News: 20 });
  });
});

describe('getCmsCategories with WordPress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return WordPress categories', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      cmsType: 'WordPress',
    });
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(VALID_WP_CONFIG));

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBe('WordPress');
    expect(response.categories).toEqual(
      expect.arrayContaining(['Technology', 'Marketing'])
    );
    expect(response.categories).toHaveLength(2);
  });

  it('should return empty categories when WordPress config has none', async () => {
    const req = mockRequest('user-123');
    const res = mockResponse();

    const configNoCategories = {
      siteUrl: 'https://example.com',
      username: 'admin',
      applicationPassword: 'xxxx',
    };

    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      cmsType: 'WordPress',
    });
    (secretExists as unknown as jest.Mock).mockResolvedValue(false);
    (getSecret as unknown as jest.Mock).mockResolvedValue(JSON.stringify(configNoCategories));

    await getCmsCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.success).toBe(true);
    expect(response.cmsType).toBe('WordPress');
    expect(response.categories).toEqual([]);
  });
});
