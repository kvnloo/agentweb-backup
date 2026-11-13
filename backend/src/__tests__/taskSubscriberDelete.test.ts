/**
 * ENG-2989: DELETE /api/tasks/:taskId/subscribers/:email only required a login: any signed-in user could remove a subscriber from
 * someone else's task (reproduced on the test environment: user B emptied user A's subscriber list). It now needs the same permission as
 * adding a subscriber: the task's owner or an admin.
 */
import request from 'supertest';
import express from 'express';

const mockGetTaskById = jest.fn();
const mockGetUserById = jest.fn();
const mockRemoveSubscriber = jest.fn();

jest.mock('../services/db', () => ({
  taskDb: { getTaskById: mockGetTaskById, getTasksByUserId: jest.fn(), getTaskSchedules: jest.fn(), getTasksWithKnowledgeBase: jest.fn() },
  subscriberDb: { removeSubscriber: mockRemoveSubscriber, getTaskSubscribers: jest.fn().mockResolvedValue([]) },
  scheduleDb: { updateSchedule: jest.fn() },
  userDb: { getUserById: mockGetUserById },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
  taskTemplateDb: {},
}));

let currentUserId = 'user-b';
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: `${currentUserId}@test.com`, isAdmin: false };
    next();
  },
}));
jest.mock('../middleware/admin', () => ({ isAdmin: (_req: any, _res: any, next: any) => next() }));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn() } }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/approvalDb', () => ({ getAssetTypeFromFilename: jest.fn() }));
jest.mock('../services/reportClassificationService', () => ({ classifyReport: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn().mockResolvedValue('fake-private-key') }));
jest.mock('../utils/fileProcessor', () => ({ isSupportedFileType: jest.fn().mockReturnValue(true), getContentType: jest.fn().mockReturnValue('application/octet-stream') }));
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })) }));
jest.mock('aws-sdk', () => {
  const ddb: any = { put: jest.fn(), get: jest.fn(), query: jest.fn(), update: jest.fn(), delete: jest.fn(), scan: jest.fn() };
  for (const k of Object.keys(ddb)) ddb[k].mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
  return { config: { update: jest.fn() }, DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => ddb) }, S3: jest.fn().mockImplementation(() => ({ deleteObject: jest.fn() })) };
});

import { authenticateToken } from '../middleware/auth';
import tasksRouter from '../routes/tasks';

const app = express();
app.use(express.json());
app.use('/api/tasks', authenticateToken, tasksRouter);

const del = (taskId = 'task-a', email = 'sub@example.com') => request(app).delete(`/api/tasks/${taskId}/subscribers/${encodeURIComponent(email)}`);

beforeEach(() => {
  jest.clearAllMocks();
  currentUserId = 'user-b';
  mockGetTaskById.mockResolvedValue({ taskId: 'task-a', userId: 'user-a', name: "A's task" });
  mockGetUserById.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id === 'admin-1' }));
  mockRemoveSubscriber.mockResolvedValue(undefined);
});

describe('removing a task subscriber needs the task owner or an admin (ENG-2989)', () => {
  it("another user cannot remove a subscriber from someone else's task: 403, nothing removed", async () => {
    const res = await del();
    expect(res.status).toBe(403);
    expect(mockRemoveSubscriber).not.toHaveBeenCalled();
  });

  it('the task owner can remove a subscriber', async () => {
    currentUserId = 'user-a';
    const res = await del();
    expect(res.status).toBe(204);
    expect(mockRemoveSubscriber).toHaveBeenCalledWith('task-a', 'sub@example.com');
  });

  it('an admin can remove a subscriber', async () => {
    currentUserId = 'admin-1';
    const res = await del();
    expect(res.status).toBe(204);
    expect(mockRemoveSubscriber).toHaveBeenCalledWith('task-a', 'sub@example.com');
  });

  it('an unknown task is a 404 and nothing is removed', async () => {
    mockGetTaskById.mockResolvedValue(null);
    expect((await del('task-x')).status).toBe(404);
    expect(mockRemoveSubscriber).not.toHaveBeenCalled();
  });

  it('a caller whose user record is missing is refused', async () => {
    currentUserId = 'ghost';
    mockGetUserById.mockResolvedValue(null);
    expect((await del()).status).toBe(401);
    expect(mockRemoveSubscriber).not.toHaveBeenCalled();
  });
});
