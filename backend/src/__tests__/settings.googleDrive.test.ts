/**
 * Tests for Google Drive settings endpoints (customer-facing)
 */
import request from 'supertest';
import express from 'express';
import settingsRoutes from '../routes/settings';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock settingsService (required by settings routes)
jest.mock('../services/settingsService', () => ({
  settingsService: {
    setSetting: jest.fn(),
    getSetting: jest.fn(),
    getSettingsByPrefix: jest.fn(),
  },
}));

// Mock db
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
  taskDb: {
    getTaskById: jest.fn(),
  },
}));

// Mock googleapis
const mockFilesGet = jest.fn();
const mockFilesList = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({})),
    },
    drive: jest.fn().mockImplementation(() => ({
      files: {
        get: mockFilesGet,
        list: mockFilesList,
      },
    })),
  },
}));

// Mock secretsManager
jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue(JSON.stringify({
    type: 'service_account',
    project_id: 'test-project',
    private_key: 'test-key',
    client_email: 'test@test.iam.gserviceaccount.com',
  })),
  getGoogleDriveServiceAccountEmail: jest.fn().mockResolvedValue('sa@test.iam.gserviceaccount.com'),
}));

import { userDb } from '../services/db';

let app: express.Application;

beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
});

describe('GET /api/settings/google-drive/service-account-email', () => {
  it('should return the service account email', async () => {
    const res = await request(app)
      .get('/api/settings/google-drive/service-account-email')
      .expect(200);

    expect(res.body.email).toBe('sa@test.iam.gserviceaccount.com');
  });

  it('should handle errors when fetching service account email', async () => {
    const { getGoogleDriveServiceAccountEmail } = require('../utils/secretsManager');
    getGoogleDriveServiceAccountEmail.mockRejectedValueOnce(new Error('Secret not found'));

    const res = await request(app)
      .get('/api/settings/google-drive/service-account-email')
      .expect(500);

    expect(res.body.error).toBe('Failed to fetch Google Drive service account email');
  });
});

describe('POST /api/settings/google-drive/folders', () => {
  it('should return 400 when folderId is missing', async () => {
    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({})
      .expect(400);

    expect(res.body.error).toBe('folderId is required');
  });

  it('should return 400 when folderId is empty string', async () => {
    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({ folderId: '  ' })
      .expect(400);

    expect(res.body.error).toBe('folderId is required');
  });

  it('should return 400 when folder ID is not a folder', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'file-1', name: 'A Document', mimeType: 'application/pdf' },
    });

    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [],
    });

    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({ folderId: 'file-1' })
      .expect(400);

    expect(res.body.error).toBe('The provided ID is not a folder');
  });

  it('should return 400 when folder not found in Drive', async () => {
    mockFilesGet.mockRejectedValue({ code: 404, status: 404 });

    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({ folderId: 'nonexistent' })
      .expect(400);

    expect(res.body.error).toContain('Folder not found');
  });

  it('should return 400 when folder already added', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'folder-1', name: 'My Folder', mimeType: 'application/vnd.google-apps.folder' },
    });

    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }],
    });

    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({ folderId: 'folder-1' })
      .expect(400);

    expect(res.body.error).toBe('This folder has already been added');
  });

  it('should successfully add a new folder', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'folder-2', name: 'New Folder', mimeType: 'application/vnd.google-apps.folder' },
    });

    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [{ folderId: 'folder-1', name: 'Existing Folder' }],
    });

    (userDb.updateUser as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({ folderId: 'folder-2' })
      .expect(200);

    expect(res.body.folder).toEqual({ folderId: 'folder-2', name: 'New Folder' });
    expect(res.body.googleDriveFolders).toHaveLength(2);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-123', {
      googleDriveFolders: [
        { folderId: 'folder-1', name: 'Existing Folder' },
        { folderId: 'folder-2', name: 'New Folder' },
      ],
    });
  });

  it('should return 404 when user not found', async () => {
    mockFilesGet.mockResolvedValue({
      data: { id: 'folder-1', name: 'Folder', mimeType: 'application/vnd.google-apps.folder' },
    });

    (userDb.getUserById as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/settings/google-drive/folders')
      .send({ folderId: 'folder-1' })
      .expect(404);

    expect(res.body.error).toBe('User not found');
  });
});

describe('DELETE /api/settings/google-drive/folders/:folderId', () => {
  it('should remove a folder from user', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [
        { folderId: 'folder-1', name: 'Folder 1' },
        { folderId: 'folder-2', name: 'Folder 2' },
      ],
    });
    (userDb.updateUser as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .delete('/api/settings/google-drive/folders/folder-1')
      .expect(200);

    expect(res.body.googleDriveFolders).toEqual([
      { folderId: 'folder-2', name: 'Folder 2' },
    ]);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-123', {
      googleDriveFolders: [{ folderId: 'folder-2', name: 'Folder 2' }],
    });
  });

  it('should return 404 when user not found', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/settings/google-drive/folders/folder-1')
      .expect(404);

    expect(res.body.error).toBe('User not found');
  });

  it('should handle removing non-existent folder gracefully', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [{ folderId: 'folder-1', name: 'Folder 1' }],
    });
    (userDb.updateUser as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .delete('/api/settings/google-drive/folders/nonexistent')
      .expect(200);

    // Still succeeds but folder list unchanged minus the nonexistent one
    expect(res.body.googleDriveFolders).toEqual([
      { folderId: 'folder-1', name: 'Folder 1' },
    ]);
  });
});

describe('GET /api/settings/google-drive/folders/:folderId/files', () => {
  it('should return files in a folder', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }],
    });

    mockFilesList.mockResolvedValue({
      data: {
        files: [
          { id: 'file-1', name: 'doc.pdf', mimeType: 'application/pdf', size: '1024', modifiedTime: '2024-01-01T00:00:00Z' },
          { id: 'file-2', name: 'notes.txt', mimeType: 'text/plain', size: '256', modifiedTime: '2024-01-02T00:00:00Z' },
        ],
      },
    });

    const res = await request(app)
      .get('/api/settings/google-drive/folders/folder-1/files')
      .expect(200);

    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[0]).toEqual({
      id: 'file-1',
      name: 'doc.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      modifiedTime: '2024-01-01T00:00:00Z',
    });
    expect(res.body.files[1]).toEqual({
      id: 'file-2',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 256,
      modifiedTime: '2024-01-02T00:00:00Z',
    });
  });

  it('should return 403 when folder does not belong to user', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }],
    });

    const res = await request(app)
      .get('/api/settings/google-drive/folders/other-folder/files')
      .expect(403);

    expect(res.body.error).toBe('Folder not found on your account');
  });

  it('should return 404 when user not found', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/settings/google-drive/folders/folder-1/files')
      .expect(404);

    expect(res.body.error).toBe('User not found');
  });

  it('should handle user with no folders array', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
    });

    const res = await request(app)
      .get('/api/settings/google-drive/folders/folder-1/files')
      .expect(403);

    expect(res.body.error).toBe('Folder not found on your account');
  });

  it('should handle files with no size field', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user-123',
      googleDriveFolders: [{ folderId: 'folder-1', name: 'My Folder' }],
    });

    mockFilesList.mockResolvedValue({
      data: {
        files: [
          { id: 'file-1', name: 'Google Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2024-01-01T00:00:00Z' },
        ],
      },
    });

    const res = await request(app)
      .get('/api/settings/google-drive/folders/folder-1/files')
      .expect(200);

    expect(res.body.files[0].size).toBeUndefined();
    expect(res.body.files[0].name).toBe('Google Doc');
  });
});
