// Unit tests for Google Drive Shared Folders configuration in AdminDashboard

import axios from 'axios';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AdminDashboard - Google Drive Shared Folders Configuration', () => {
  const mockToken = 'test-token';
  const mockUserId = 'user1';

  describe('Google Drive folders API calls', () => {
    it('should call API with correct endpoint and payload to update folders', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          googleDriveFolders: [
            { folderId: 'folder-1', name: 'My Folder' },
            { folderId: 'folder-2', name: 'Another Folder' }
          ]
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/google-drive-folders`,
        { googleDriveFolders: [
          { folderId: 'folder-1', name: 'My Folder' },
          { folderId: 'folder-2', name: 'Another Folder' }
        ] },
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/users/user1/google-drive-folders'),
        { googleDriveFolders: [
          { folderId: 'folder-1', name: 'My Folder' },
          { folderId: 'folder-2', name: 'Another Folder' }
        ] },
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.googleDriveFolders).toEqual([
        { folderId: 'folder-1', name: 'My Folder' },
        { folderId: 'folder-2', name: 'Another Folder' }
      ]);
    });

    it('should call API to list available Google Drive folders', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          folders: [
            { folderId: 'folder-1', name: 'Shared Folder 1' },
            { folderId: 'folder-2', name: 'Shared Folder 2' }
          ]
        },
        status: 200
      });

      const response = await mockedAxios.get(
        `http://localhost:3001/api/admin/google-drive-folders`,
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/google-drive-folders'),
        expect.objectContaining({
          headers: { Authorization: `Bearer ${mockToken}` }
        })
      );
      expect(response.data.folders).toHaveLength(2);
      expect(response.data.folders[0].name).toBe('Shared Folder 1');
    });

    it('should handle API errors when updating folders', async () => {
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { message: 'googleDriveFolders must be an array' }
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/${mockUserId}/google-drive-folders`,
          { googleDriveFolders: 'not-an-array' },
          { headers: { Authorization: `Bearer ${mockToken}` } }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toBe('googleDriveFolders must be an array');
      }
    });

    it('should handle API errors for invalid folder entries', async () => {
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { message: 'Each folder must have a non-empty folderId string' }
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/${mockUserId}/google-drive-folders`,
          { googleDriveFolders: [{ folderId: '', name: 'Folder' }] },
          { headers: { Authorization: `Bearer ${mockToken}` } }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(400);
        expect(error.response.data.message).toContain('non-empty folderId');
      }
    });

    it('should call API with empty array to clear all folders', async () => {
      mockedAxios.put.mockResolvedValueOnce({
        data: {
          userId: mockUserId,
          googleDriveFolders: []
        },
        status: 200
      });

      const response = await mockedAxios.put(
        `http://localhost:3001/api/admin/users/${mockUserId}/google-drive-folders`,
        { googleDriveFolders: [] },
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );

      expect(response.data.googleDriveFolders).toEqual([]);
    });

    it('should handle user not found error', async () => {
      mockedAxios.put.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { message: 'User not found' }
        }
      });

      try {
        await mockedAxios.put(
          `http://localhost:3001/api/admin/users/nonexistent/google-drive-folders`,
          { googleDriveFolders: [] },
          { headers: { Authorization: `Bearer ${mockToken}` } }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(404);
        expect(error.response.data.message).toBe('User not found');
      }
    });

    it('should handle empty folders list from Google Drive', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { folders: [] },
        status: 200
      });

      const response = await mockedAxios.get(
        `http://localhost:3001/api/admin/google-drive-folders`,
        { headers: { Authorization: `Bearer ${mockToken}` } }
      );

      expect(response.data.folders).toEqual([]);
    });

    it('should handle server error when listing Drive folders', async () => {
      mockedAxios.get.mockRejectedValueOnce({
        response: {
          status: 500,
          data: { message: 'Failed to list Google Drive folders' }
        }
      });

      try {
        await mockedAxios.get(
          `http://localhost:3001/api/admin/google-drive-folders`,
          { headers: { Authorization: `Bearer ${mockToken}` } }
        );
      } catch (error: any) {
        expect(error.response.status).toBe(500);
        expect(error.response.data.message).toBe('Failed to list Google Drive folders');
      }
    });
  });
});
