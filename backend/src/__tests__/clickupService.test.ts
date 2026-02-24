import axios from 'axios';
import { getAccessToken, getWorkspaces, listDocs, readDocContent } from '../services/clickupService';

jest.mock('axios');
const mockAxiosGet = axios.get as jest.Mock;

const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
  },
}));

const mockDecryptPassword = jest.fn();
jest.mock('../utils/crypto', () => ({
  decryptPassword: (...args: any[]) => mockDecryptPassword(...args),
}));

describe('clickupService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAccessToken', () => {
    it('should return null when user has no ClickUp token', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-1', secrets: {} });

      const token = await getAccessToken('user-1');
      expect(token).toBeNull();
    });

    it('should return decrypted token when user has ClickUp connected', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-1',
        secrets: { clickup_access_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'ck_test_token' });

      const token = await getAccessToken('user-1');
      expect(token).toBe('ck_test_token');
      expect(mockDecryptPassword).toHaveBeenCalledWith('encrypted-token');
    });

    it('should return null when decryption fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-1',
        secrets: { clickup_access_token: 'corrupted' },
      });
      mockDecryptPassword.mockImplementation(() => { throw new Error('Decryption failed'); });

      const token = await getAccessToken('user-1');
      expect(token).toBeNull();
    });

    it('should return null when user has null secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-1', secrets: null });

      const token = await getAccessToken('user-1');
      expect(token).toBeNull();
    });
  });

  describe('getWorkspaces', () => {
    it('should return workspaces from ClickUp API', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          teams: [
            { id: 'ws-1', name: 'Workspace 1', avatar: 'https://img.url' },
            { id: 'ws-2', name: 'Workspace 2' },
          ],
        },
      });

      const workspaces = await getWorkspaces('ck_test_token');
      expect(workspaces).toEqual([
        { id: 'ws-1', name: 'Workspace 1', avatar: 'https://img.url' },
        { id: 'ws-2', name: 'Workspace 2', avatar: null },
      ]);
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team',
        { headers: { Authorization: 'ck_test_token' } }
      );
    });

    it('should handle null teams array', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { teams: null } });

      const workspaces = await getWorkspaces('ck_test_token');
      expect(workspaces).toEqual([]);
    });
  });

  describe('listDocs', () => {
    it('should list docs and filter out deleted/archived', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          docs: [
            { id: 'doc-1', name: 'Active', date_created: '1000', date_updated: '2000', deleted: false, archived: false },
            { id: 'doc-2', name: 'Deleted', date_created: '1000', date_updated: '2000', deleted: true, archived: false },
            { id: 'doc-3', name: 'Archived', date_created: '1000', date_updated: '2000', deleted: false, archived: true },
          ],
        },
      });

      const docs = await listDocs('ck_token', 'ws-1');
      expect(docs).toEqual([
        { id: 'doc-1', name: 'Active', dateCreated: '1000', dateUpdated: '2000' },
      ]);
    });

    it('should handle pagination with next_cursor', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            docs: [{ id: 'doc-1', name: 'Page 1', date_created: '1000', date_updated: '2000', deleted: false, archived: false }],
            next_cursor: 'cursor-2',
          },
        })
        .mockResolvedValueOnce({
          data: {
            docs: [{ id: 'doc-2', name: 'Page 2', date_created: '3000', date_updated: '4000', deleted: false, archived: false }],
          },
        });

      const docs = await listDocs('ck_token', 'ws-1');
      expect(docs).toHaveLength(2);
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
      expect(mockAxiosGet).toHaveBeenNthCalledWith(2,
        expect.stringContaining('cursor=cursor-2'),
        expect.anything()
      );
    });

    it('should handle null docs array', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { docs: null } });

      const docs = await listDocs('ck_token', 'ws-1');
      expect(docs).toEqual([]);
    });

    it('should use date_created as fallback for missing date_updated', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          docs: [
            { id: 'doc-1', name: 'No Update', date_created: '5000', date_updated: null, deleted: false, archived: false },
          ],
        },
      });

      const docs = await listDocs('ck_token', 'ws-1');
      expect(docs[0].dateUpdated).toBe('5000');
    });
  });

  describe('readDocContent', () => {
    it('should concatenate all page contents with titles', async () => {
      // List pages returns content inline
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          pages: [
            { id: 'p-1', name: 'Introduction', content: 'Welcome to the doc.' },
            { id: 'p-2', name: 'Details', content: 'Here are the details.' },
          ],
        },
      });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toContain('# Introduction');
      expect(content).toContain('Welcome to the doc.');
      expect(content).toContain('# Details');
      expect(content).toContain('Here are the details.');
      expect(content).toContain('---');
      // Should not fetch individual pages since content was provided
      expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    });

    it('should handle raw array response from v3 API', async () => {
      // v3 API returns a raw array, not { pages: [...] }
      mockAxiosGet
        .mockResolvedValueOnce({
          data: [
            { id: 'p-1', name: 'Page One', content: '' },
            { id: 'p-2', name: 'Page Two', content: '' },
          ],
        })
        // Individual page fetches
        .mockResolvedValueOnce({ data: { id: 'p-1', name: 'Page One', content: 'Content from page one.' } })
        .mockResolvedValueOnce({ data: { id: 'p-2', name: 'Page Two', content: 'Content from page two.' } });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toContain('# Page One');
      expect(content).toContain('Content from page one.');
      expect(content).toContain('# Page Two');
      expect(content).toContain('Content from page two.');
      // 1 list call + 2 individual page fetches
      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
    });

    it('should fetch individual pages when list content is empty', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            pages: [{ id: 'p-1', name: 'My Page', content: '' }],
          },
        })
        .mockResolvedValueOnce({ data: { id: 'p-1', name: 'My Page', content: 'Fetched individually.' } });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toBe('# My Page\n\nFetched individually.');
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
      expect(mockAxiosGet).toHaveBeenNthCalledWith(2,
        expect.stringContaining('/pages/p-1'),
        expect.anything()
      );
    });

    it('should handle pages without titles', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          pages: [{ id: 'p-1', content: 'Content without title.' }],
        },
      });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toBe('Content without title.');
      expect(content).not.toContain('#');
    });

    it('should handle empty pages array', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: { pages: [] } });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toBe('');
    });

    it('should handle response with data array instead of pages', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          data: [{ id: 'p-1', name: 'Page 1', content: 'Content from data array.' }],
        },
      });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toContain('Content from data array.');
    });

    it('should skip pages with no id', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: [
          { id: 'p-1', name: 'Real Page', content: 'Real content.' },
          { name: 'No ID Page', content: 'Should be skipped.' },
        ],
      });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toBe('# Real Page\n\nReal content.');
    });

    it('should skip pages with no title and no content after individual fetch', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            pages: [
              { id: 'p-1', name: 'Real Page', content: 'Real content.' },
              { id: 'p-2', name: '', content: '' },
            ],
          },
        })
        // Individual fetch for p-2 also returns empty
        .mockResolvedValueOnce({ data: { id: 'p-2', name: '', content: '' } });

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toBe('# Real Page\n\nReal content.');
    });

    it('should gracefully handle individual page fetch failure', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: [
            { id: 'p-1', name: 'Good Page', content: '' },
            { id: 'p-2', name: 'Bad Page', content: '' },
          ],
        })
        .mockResolvedValueOnce({ data: { id: 'p-1', name: 'Good Page', content: 'Good content.' } })
        .mockRejectedValueOnce(new Error('API Error'));

      const content = await readDocContent('ck_token', 'ws-1', 'doc-1');
      expect(content).toContain('Good content.');
      // Bad Page has title from list but no content, should still show title
      expect(content).toContain('# Bad Page');
    });
  });
});
