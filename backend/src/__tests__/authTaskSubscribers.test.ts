/**
 * ENG-2989: the auth router's task subscriber routes (`POST` and `DELETE /api/auth/tasks/:taskId/subscribers[/:email]`) only required a
 * login. Reproduced on the test environment: user B added an address to user A's task (201) and removed one (204). Both now need the
 * task's owner or an admin.
 */
import request from 'supertest';
import express from 'express';

const mockGetTaskById = jest.fn();
const mockGetUserById = jest.fn();
const mockAddSubscriber = jest.fn();
const mockRemoveSubscriber = jest.fn();

jest.mock('../services/db', () => ({
  userDb: { getUserById: mockGetUserById },
  taskDb: { getTaskById: mockGetTaskById },
  subscriberDb: { addSubscriber: mockAddSubscriber, removeSubscriber: mockRemoveSubscriber, getTaskSubscribers: jest.fn().mockResolvedValue([]) },
  orgDb: { getOrgById: jest.fn() },
}));

let currentUserId = 'user-b';
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: `${currentUserId}@test.com`, isAdmin: false };
    next();
  },
}));
jest.mock('../services/analyticsConfigResolver', () => ({ resolveAnalyticsConfig: jest.fn(), resolveConfigTarget: jest.fn() }));

import authRoutes from '../routes/auth';
import { checkTaskSubscriberAccess } from '../services/taskSubscriberAccess';

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

const add = (email = 'new@example.com') => request(app).post('/api/auth/tasks/task-a/subscribers').send({ email });
const remove = (email = 'sub@example.com') => request(app).delete(`/api/auth/tasks/task-a/subscribers/${encodeURIComponent(email)}`);

beforeEach(() => {
  jest.clearAllMocks();
  currentUserId = 'user-b';
  mockGetTaskById.mockResolvedValue({ taskId: 'task-a', userId: 'user-a' });
  mockGetUserById.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id === 'admin-1' }));
  mockAddSubscriber.mockResolvedValue({ taskId: 'task-a', email: 'new@example.com' });
  mockRemoveSubscriber.mockResolvedValue(undefined);
});

describe('auth router task subscriber routes need the task owner or an admin (ENG-2989)', () => {
  it("another user cannot add an address to someone else's task: 403, nothing added", async () => {
    expect((await add()).status).toBe(403);
    expect(mockAddSubscriber).not.toHaveBeenCalled();
  });

  it("another user cannot remove a subscriber from someone else's task: 403, nothing removed", async () => {
    expect((await remove()).status).toBe(403);
    expect(mockRemoveSubscriber).not.toHaveBeenCalled();
  });

  it('the owner can add and remove', async () => {
    currentUserId = 'user-a';
    expect((await add()).status).toBe(201);
    expect(mockAddSubscriber).toHaveBeenCalledWith('task-a', 'new@example.com');
    expect((await remove()).status).toBe(204);
    expect(mockRemoveSubscriber).toHaveBeenCalledWith('task-a', 'sub@example.com');
  });

  it('an admin can add and remove', async () => {
    currentUserId = 'admin-1';
    expect((await add()).status).toBe(201);
    expect((await remove()).status).toBe(204);
  });

  it('an unknown task is a 404 and nothing changes', async () => {
    mockGetTaskById.mockResolvedValue(null);
    expect((await add()).status).toBe(404);
    expect((await remove()).status).toBe(404);
    expect(mockAddSubscriber).not.toHaveBeenCalled();
    expect(mockRemoveSubscriber).not.toHaveBeenCalled();
  });

  it('the email is still required', async () => {
    currentUserId = 'user-a';
    expect((await request(app).post('/api/auth/tasks/task-a/subscribers').send({})).status).toBe(400);
  });
});

describe('checkTaskSubscriberAccess', () => {
  it('refuses a missing caller, an unknown task, an unknown user, a stranger; allows owner and admin', async () => {
    expect(await checkTaskSubscriberAccess(undefined, 'task-a')).toMatchObject({ ok: false, status: 401 });
    mockGetTaskById.mockResolvedValueOnce(null);
    expect(await checkTaskSubscriberAccess('user-a', 'nope')).toMatchObject({ ok: false, status: 404 });
    mockGetUserById.mockResolvedValueOnce(null);
    expect(await checkTaskSubscriberAccess('ghost', 'task-a')).toMatchObject({ ok: false, status: 401 });
    expect(await checkTaskSubscriberAccess('user-b', 'task-a')).toMatchObject({ ok: false, status: 403 });
    expect(await checkTaskSubscriberAccess('user-a', 'task-a')).toEqual({ ok: true });
    expect(await checkTaskSubscriberAccess('admin-1', 'task-a')).toEqual({ ok: true });
  });
});
