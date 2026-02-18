/**
 * Tests for Admin Google Drive Folders endpoints
 */

// Mock the auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: jest.fn()
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: jest.fn()
}));

import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;
const mockedIsAdmin = isAdmin as jest.MockedFunction<typeof isAdmin>;

// Mock the database service
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn()
  }
}));

// Mock googleapis
const mockFilesList = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({}))
    },
    drive: jest.fn().mockImplementation(() => ({
      files: {
        list: mockFilesList
      }
    }))
  }
}));

// Mock secretsManager
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key: 'test-key',
    client_email: 'test@test.iam.gserviceaccount.com'
  }))
}));

import express from 'express';
import request from 'supertest';
import adminRoutes from '../routes/admin';
import { userDb } from '../services/db';

describe('Admin Google Drive Folders', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());

    mockedAuthenticateToken.mockImplementation(async (req: any, res: any, next: any) => {
      (req as any).user = {
        userId: 'admin-user-123',
        email: 'admin@example.com'
      };
      next();
      return undefined;
    });

    mockedIsAdmin.mockImplementation(async (req: any, res: any, next: any) => {
      next();
      return undefined;
    });

    app.use('/api/admin', adminRoutes);
  });

  describe('PUT /api/admin/users/:userId/google-drive-folders', () => {
    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }]
        })
        .expect(404);

      expect(response.body.message).toBe('User not found');
    });

    it('should return 400 if googleDriveFolders is not an array', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: 'not-an-array'
        })
        .expect(400);

      expect(response.body.message).toBe('googleDriveFolders must be an array');
    });

    it('should return 400 if a folder has empty folderId', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: [{ folderId: '', name: 'My Folder' }]
        })
        .expect(400);

      expect(response.body.message).toBe('Each folder must have a non-empty folderId string');
    });

    it('should return 400 if a folder has empty name', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: [{ folderId: 'folder-1', name: '' }]
        })
        .expect(400);

      expect(response.body.message).toBe('Each folder must have a non-empty name string');
    });

    it('should update user with valid Google Drive folders', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleDriveFolders: [
          { folderId: 'folder-1', name: 'My Folder' },
          { folderId: 'folder-2', name: 'Another Folder' }
        ]
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: [
            { folderId: 'folder-1', name: 'My Folder' },
            { folderId: 'folder-2', name: 'Another Folder' }
          ]
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        googleDriveFolders: [
          { folderId: 'folder-1', name: 'My Folder' },
          { folderId: 'folder-2', name: 'Another Folder' }
        ]
      });
      expect(response.body.googleDriveFolders).toEqual([
        { folderId: 'folder-1', name: 'My Folder' },
        { folderId: 'folder-2', name: 'Another Folder' }
      ]);
    });

    it('should trim whitespace from folderId and name', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }]
      });

      await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: [{ folderId: '  folder-1  ', name: '  My Folder  ' }]
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }]
      });
    });

    it('should allow empty array to clear folders', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleDriveFolders: [{ folderId: 'folder-1', name: 'Old Folder' }]
      });
      (userDb.updateUser as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com',
        googleDriveFolders: []
      });

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: []
        })
        .expect(200);

      expect(userDb.updateUser).toHaveBeenCalledWith('test-user-123', {
        googleDriveFolders: []
      });
      expect(response.body.googleDriveFolders).toEqual([]);
    });

    it('should handle database errors gracefully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({
        userId: 'test-user-123',
        email: 'test@example.com'
      });
      (userDb.updateUser as jest.Mock).mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .put('/api/admin/users/test-user-123/google-drive-folders')
        .send({
          googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }]
        })
        .expect(500);

      expect(response.body.message).toBe('Error updating Google Drive folders');
    });
  });

  describe('GET /api/admin/google-drive-folders', () => {
    it('should return list of folders from Google Drive', async () => {
      mockFilesList.mockResolvedValue({
        data: {
          files: [
            { id: 'folder-1', name: 'Shared Folder 1' },
            { id: 'folder-2', name: 'Shared Folder 2' }
          ]
        }
      });

      const response = await request(app)
        .get('/api/admin/google-drive-folders')
        .expect(200);

      expect(response.body.folders).toEqual([
        { folderId: 'folder-1', name: 'Shared Folder 1' },
        { folderId: 'folder-2', name: 'Shared Folder 2' }
      ]);
    });

    it('should return empty list when no folders are shared', async () => {
      mockFilesList.mockResolvedValue({
        data: { files: [] }
      });

      const response = await request(app)
        .get('/api/admin/google-drive-folders')
        .expect(200);

      expect(response.body.folders).toEqual([]);
    });

    it('should handle Google Drive API errors', async () => {
      mockFilesList.mockRejectedValue(new Error('Google Drive API error'));

      const response = await request(app)
        .get('/api/admin/google-drive-folders')
        .expect(500);

      expect(response.body.message).toBe('Failed to list Google Drive folders');
    });
  });
});
