import axios from 'axios';
import { getAccessToken, getWorkspaces, listDocs, readDocContent, listTasks, readTaskContent, createDoc, editPage } from '../services/clickupService';

jest.mock('axios');
const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;
const mockAxiosPut = axios.put as jest.Mock;

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

  describe('listTasks', () => {
    it('should list tasks with pagination and enrich attachments', async () => {
      mockAxiosGet
        // Page 0 of list
        .mockResolvedValueOnce({
          data: {
            tasks: [
              {
                id: 'task-1',
                name: 'Build feature',
                description: 'Build the new feature',
                status: { status: 'in progress' },
                assignees: [{ username: 'alice' }],
                due_date: '1700000000000',
                tags: [{ name: 'frontend' }],
                priority: { priority: 'high' },
                attachments: [
                  { id: 'att-1', title: 'mockup.png', url: 'https://att.url/mockup.png', size: 12345 },
                ],
                date_created: '1690000000000',
                date_updated: '1695000000000',
              },
            ],
            last_page: false,
          },
        })
        // Page 1 of list
        .mockResolvedValueOnce({
          data: {
            tasks: [
              {
                id: 'task-2',
                name: 'Fix bug',
                description: 'Fix the login bug',
                status: { status: 'open' },
                assignees: [],
                due_date: null,
                tags: [],
                priority: null,
                attachments: [],
                date_created: '1691000000000',
                date_updated: '1696000000000',
              },
            ],
            last_page: true,
          },
        })
        // Individual fetch for task-2 (no attachments from list, enrichment kicks in)
        .mockResolvedValueOnce({
          data: {
            id: 'task-2',
            name: 'Fix bug',
            description: 'Fix the login bug',
            status: { status: 'open' },
            assignees: [],
            due_date: null,
            tags: [],
            priority: null,
            attachments: [
              { id: 'att-2', title: 'screenshot.png', url: 'https://att.url/screenshot.png', size: 5000 },
            ],
            date_created: '1691000000000',
            date_updated: '1696000000000',
          },
        });

      const tasks = await listTasks('ck_token', 'ws-1');
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toEqual({
        id: 'task-1',
        name: 'Build feature',
        description: 'Build the new feature',
        status: 'in progress',
        assignees: ['alice'],
        dueDate: '1700000000000',
        tags: ['frontend'],
        priority: 'high',
        attachments: [
          { id: 'att-1', title: 'mockup.png', url: 'https://att.url/mockup.png', size: 12345 },
        ],
        dateCreated: '1690000000000',
        dateUpdated: '1695000000000',
      });
      expect(tasks[1].name).toBe('Fix bug');
      // task-2 was enriched with attachments from individual fetch
      expect(tasks[1].attachments).toEqual([
        { id: 'att-2', title: 'screenshot.png', url: 'https://att.url/screenshot.png', size: 5000 },
      ]);
      // 2 list calls + 1 individual fetch (task-1 skipped because it had attachments)
      expect(mockAxiosGet).toHaveBeenCalledTimes(3);
    });

    it('should handle empty tasks array', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { tasks: [], last_page: true },
      });

      const tasks = await listTasks('ck_token', 'ws-1');
      expect(tasks).toEqual([]);
    });

    it('should handle null tasks array', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { tasks: null, last_page: true },
      });

      const tasks = await listTasks('ck_token', 'ws-1');
      expect(tasks).toEqual([]);
    });

    it('should call correct API URL with pagination parameters', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: { tasks: [], last_page: true },
      });

      await listTasks('ck_token', 'ws-1');
      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('https://api.clickup.com/api/v2/team/ws-1/task'),
        { headers: { Authorization: 'ck_token' } }
      );
      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('page=0'),
        expect.anything()
      );
    });

    it('should handle tasks with missing optional fields gracefully', async () => {
      mockAxiosGet
        // List endpoint
        .mockResolvedValueOnce({
          data: {
            tasks: [
              {
                id: 'task-1',
                name: 'Minimal task',
                // no description, status, assignees, due_date, tags, priority, attachments
                date_created: '1000',
              },
            ],
            last_page: true,
          },
        })
        // Individual fetch for enrichment (also returns no attachments)
        .mockResolvedValueOnce({
          data: {
            id: 'task-1',
            name: 'Minimal task',
            date_created: '1000',
          },
        });

      const tasks = await listTasks('ck_token', 'ws-1');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toEqual({
        id: 'task-1',
        name: 'Minimal task',
        description: '',
        status: '',
        assignees: [],
        dueDate: null,
        tags: [],
        priority: null,
        attachments: [],
        dateCreated: '1000',
        dateUpdated: '1000',
      });
    });

    it('should handle attachments with missing fields', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          tasks: [
            {
              id: 'task-1',
              name: 'Task with attachments',
              attachments: [
                { id: 'att-1', title: 'file.pdf', url: 'https://att.url/file.pdf' },
                { id: 'att-2', url: 'https://att.url/noname' },
              ],
              date_created: '1000',
              date_updated: '2000',
            },
          ],
          last_page: true,
        },
      });

      const tasks = await listTasks('ck_token', 'ws-1');
      expect(tasks[0].attachments).toEqual([
        { id: 'att-1', title: 'file.pdf', url: 'https://att.url/file.pdf', size: undefined },
        { id: 'att-2', title: '', url: 'https://att.url/noname', size: undefined },
      ]);
    });
  });

  describe('readTaskContent', () => {
    it('should format task as markdown with all fields', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          id: 'task-1',
          name: 'Build feature X',
          description: 'Implement the new feature X for the dashboard.',
          status: { status: 'in progress' },
          assignees: [{ username: 'alice' }, { username: 'bob' }],
          due_date: '1700000000000',
          tags: [{ name: 'frontend' }, { name: 'priority' }],
          priority: { priority: 'high' },
          attachments: [
            { id: 'att-1', title: 'mockup.png', url: 'https://att.url/mockup.png', size: 12345 },
            { id: 'att-2', title: 'spec.pdf', url: 'https://att.url/spec.pdf', size: 98765 },
          ],
          date_created: '1690000000000',
          date_updated: '1695000000000',
        },
      });

      const content = await readTaskContent('ck_token', 'task-1');
      expect(content).toContain('# Build feature X');
      expect(content).toContain('**Status:** in progress');
      expect(content).toContain('**Priority:** high');
      expect(content).toContain('**Assignees:** alice, bob');
      expect(content).toContain('**Due Date:**');
      expect(content).toContain('**Tags:** frontend, priority');
      expect(content).toContain('Implement the new feature X for the dashboard.');
      expect(content).toContain('## Attachments');
      expect(content).toContain('mockup.png');
      expect(content).toContain('spec.pdf');
      expect(content).toContain('https://att.url/mockup.png');
    });

    it('should handle task with no description', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          id: 'task-1',
          name: 'No description task',
          description: null,
          status: { status: 'open' },
          assignees: [],
          due_date: null,
          tags: [],
          priority: null,
          attachments: [],
          date_created: '1000',
          date_updated: '2000',
        },
      });

      const content = await readTaskContent('ck_token', 'task-1');
      expect(content).toContain('# No description task');
      expect(content).toContain('**Status:** open');
      expect(content).not.toContain('**Priority:**');
      expect(content).not.toContain('**Assignees:**');
      expect(content).not.toContain('**Due Date:**');
      expect(content).not.toContain('**Tags:**');
      expect(content).not.toContain('## Attachments');
      expect(content).not.toContain('## Description');
    });

    it('should handle task with empty attachments', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          id: 'task-1',
          name: 'Task',
          description: 'Some description',
          status: { status: 'done' },
          assignees: [],
          attachments: [],
          date_created: '1000',
        },
      });

      const content = await readTaskContent('ck_token', 'task-1');
      expect(content).not.toContain('## Attachments');
      expect(content).toContain('## Description');
      expect(content).toContain('Some description');
    });

    it('should call correct API URL', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          id: 'task-abc',
          name: 'Test',
          status: { status: 'open' },
          date_created: '1000',
        },
      });

      await readTaskContent('ck_token', 'task-abc');
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/task/task-abc',
        { headers: { Authorization: 'ck_token' } }
      );
    });

    it('should handle missing optional fields gracefully', async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          id: 'task-1',
          name: 'Minimal',
          date_created: '1000',
        },
      });

      const content = await readTaskContent('ck_token', 'task-1');
      expect(content).toContain('# Minimal');
      // Should not throw
    });
  });

  describe('createDoc', () => {
    it('should create a doc with create_page:false and return id and name', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: { id: 'doc-new-1', name: 'My New Doc' },
      });

      const result = await createDoc('ck_token', 'ws-1', 'My New Doc');
      expect(result).toEqual({ id: 'doc-new-1', name: 'My New Doc' });
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v3/workspaces/ws-1/docs',
        { name: 'My New Doc', create_page: false },
        { headers: { Authorization: 'ck_token', 'Content-Type': 'application/json' } }
      );
    });

    it('should propagate API errors', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('Forbidden'));

      await expect(createDoc('ck_token', 'ws-1', 'Doc'))
        .rejects.toThrow('Forbidden');
    });
  });

  describe('editPage', () => {
    it('should update a page successfully', async () => {
      mockAxiosPut.mockResolvedValueOnce({ data: {} });

      await editPage('ck_token', 'ws-1', 'doc-1', 'page-1', 'Updated content');
      expect(mockAxiosPut).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v3/workspaces/ws-1/docs/doc-1/pages/page-1',
        { content: 'Updated content' },
        { headers: { Authorization: 'ck_token', 'Content-Type': 'application/json' } }
      );
    });

    it('should propagate API errors', async () => {
      mockAxiosPut.mockRejectedValueOnce(new Error('Not Found'));

      await expect(editPage('ck_token', 'ws-1', 'doc-1', 'page-1', 'content'))
        .rejects.toThrow('Not Found');
    });
  });
});
