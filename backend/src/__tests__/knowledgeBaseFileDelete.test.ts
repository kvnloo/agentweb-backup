/**
 * ENG-2986: DELETE /api/tasks/:taskId/knowledge-base/files/:fileKey must only delete a storage object that is listed on THAT task.
 * Reproduced on the test environment 2026-11-13: user B, who can edit B's own task, named user A's file key and A's object was
 * deleted from storage (A's file then read as "not found"). The route used the key straight from the URL.
 * The sibling DELETE /api/tasks/:taskId/attachments/:key had the same hole (found by the review): it only checked task ownership and
 * sent the URL key to S3.
 */
import request from 'supertest';
import express from 'express';

const mockGetTaskById = jest.fn();
const mockUpdateTask = jest.fn();
const mockGcsDelete = jest.fn();
const mockGcsFile = jest.fn();
const mockS3DeleteObject = jest.fn();
const mockDeleteAttachment = jest.fn();

jest.mock('../services/db', () => ({
  taskDb: { getTaskById: mockGetTaskById, updateTask: mockUpdateTask, deleteAttachment: mockDeleteAttachment, getTasksByUserId: jest.fn(), getTaskSchedules: jest.fn(), getTasksWithKnowledgeBase: jest.fn() },
  subscriberDb: { getTaskSubscribers: jest.fn().mockResolvedValue([]) },
  scheduleDb: { updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn(async (id: string) => ({ userId: id, orgRole: 'member' })) },
  orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() },
  taskTemplateDb: {},
}));

let currentUserId = 'user-b';
let currentIsAdmin = false;
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: `${currentUserId}@test.com`, isAdmin: currentIsAdmin };
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
jest.mock('@google-cloud/storage', () => {
  const file = { exists: jest.fn().mockResolvedValue([true]), delete: mockGcsDelete };
  const bucket = { file: mockGcsFile.mockReturnValue(file) };
  const storage = { bucket: jest.fn().mockReturnValue(bucket) };
  return { Storage: jest.fn().mockImplementation(() => storage) };
});
jest.mock('aws-sdk', () => {
  const ddb = { put: jest.fn(), get: jest.fn(), query: jest.fn(), update: jest.fn(), delete: jest.fn(), scan: jest.fn() };
  for (const k of Object.keys(ddb)) (ddb as any)[k].mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) });
  return {
    config: { update: jest.fn() },
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(() => ddb) },
    S3: jest.fn().mockImplementation(() => ({ deleteObject: mockS3DeleteObject.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  };
});

import { authenticateToken } from '../middleware/auth';
import tasksRouter from '../routes/tasks';

const app = express();
app.use(express.json());
app.use('/api/tasks', authenticateToken, tasksRouter);

const GCS_KEY = 'tasks/task-b/knowledge-base-files/1794561990749_mine.md';
const S3_KEY = 's3:uploads/user-b/report.pdf';
const FOREIGN_GCS_KEY = 'tasks/task-a/knowledge-base-files/1794561990000_victim.md'; // user A's file
const FOREIGN_S3_KEY = 's3:uploads/user-a/secret.pdf';

const taskB = () => ({
  taskId: 'task-b', userId: 'user-b', name: 'B task', status: 'active',
  knowledgeBaseFiles: [
    { filename: 'mine.md', key: GCS_KEY },
    { filename: 'report.pdf', key: S3_KEY },
    { filename: '100%.md', key: 'tasks/task-b/knowledge-base-files/5_100%25.md' },
  ],
});

const del = (key: string) => request(app).delete(`/api/tasks/task-b/knowledge-base/files/${encodeURIComponent(key)}`);

beforeEach(() => {
  jest.clearAllMocks();
  currentUserId = 'user-b';
  currentIsAdmin = false;
  mockGetTaskById.mockResolvedValue(taskB());
  mockUpdateTask.mockResolvedValue(undefined);
  mockGcsDelete.mockResolvedValue(undefined);
  mockS3DeleteObject.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
});

describe('knowledge-base file delete only touches files listed on the task (ENG-2986)', () => {
  it("another account's storage key (GCS) is refused with 404 and nothing is deleted or updated", async () => {
    const res = await del(FOREIGN_GCS_KEY);
    expect(res.status).toBe(404);
    expect(mockGcsFile).not.toHaveBeenCalledWith(FOREIGN_GCS_KEY);
    expect(mockGcsDelete).not.toHaveBeenCalled();
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("another account's storage key (S3) is refused with 404 and nothing is deleted or updated", async () => {
    const res = await del(FOREIGN_S3_KEY);
    expect(res.status).toBe(404);
    expect(mockS3DeleteObject).not.toHaveBeenCalled();
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('an admin is held to the same rule', async () => {
    currentUserId = 'admin-1'; currentIsAdmin = true;
    expect((await del(FOREIGN_GCS_KEY)).status).toBe(404);
    expect(mockGcsDelete).not.toHaveBeenCalled();
  });

  it('a listed GCS file is deleted and removed from the list', async () => {
    const res = await del(GCS_KEY);
    expect(res.status).toBe(200);
    expect(mockGcsFile).toHaveBeenCalledWith(GCS_KEY);
    expect(mockGcsDelete).toHaveBeenCalledTimes(1);
    const update = mockUpdateTask.mock.calls[0][1];
    expect(update.knowledgeBaseFiles.map((f: any) => f.key)).not.toContain(GCS_KEY);
    expect(update.knowledgeBaseFiles).toHaveLength(2);
  });

  it('a listed S3 file is deleted from S3 under its own key', async () => {
    const res = await del(S3_KEY);
    expect(res.status).toBe(200);
    expect(mockS3DeleteObject).toHaveBeenCalledWith(expect.objectContaining({ Key: 'uploads/user-b/report.pdf' }));
  });

  it('a listed key that contains a literal % still works (no double decoding to a different key)', async () => {
    const res = await del('tasks/task-b/knowledge-base-files/5_100%25.md');
    expect(res.status).toBe(200);
    expect(mockGcsFile).toHaveBeenCalledWith('tasks/task-b/knowledge-base-files/5_100%25.md');
  });

  it('an older client that double-encodes the key still deletes its listed file', async () => {
    const res = await request(app).delete(`/api/tasks/task-b/knowledge-base/files/${encodeURIComponent(encodeURIComponent(GCS_KEY))}`);
    expect(res.status).toBe(200);
    expect(mockGcsFile).toHaveBeenCalledWith(GCS_KEY);
  });

  it('a malformed escape sequence is a 404, not a 500', async () => {
    const res = await request(app).delete('/api/tasks/task-b/knowledge-base/files/%E0%A4%A');
    expect([400, 404]).toContain(res.status);
    expect(mockGcsDelete).not.toHaveBeenCalled();
  });

  it('a traversal or lookalike key is not a listed key', async () => {
    expect((await del('tasks/task-b/knowledge-base-files/../../task-a/knowledge-base-files/1794561990000_victim.md')).status).toBe(404);
    expect((await del(GCS_KEY + '/../x')).status).toBe(404);
    expect(mockGcsDelete).not.toHaveBeenCalled();
  });

  it('deleting the same file twice: the second is a 404, storage is not touched again', async () => {
    mockGetTaskById.mockResolvedValue({ ...taskB(), knowledgeBaseFiles: [] });
    expect((await del(GCS_KEY)).status).toBe(404);
    expect(mockGcsDelete).not.toHaveBeenCalled();
  });

  it('a user who cannot edit the task still gets 403 first', async () => {
    currentUserId = 'user-x';
    expect((await del(GCS_KEY)).status).toBe(403);
    expect(mockGcsDelete).not.toHaveBeenCalled();
  });
});

describe('task attachment delete only touches attachments listed on the task (ENG-2986, sibling route)', () => {
  const ATT_KEY = 'tasks/task-b/attachments/1794561990749_note.png';
  const FOREIGN_ATT_KEY = 'users/user-a/files/1794561990000/tok/secret.png';
  const delAtt = (key: string) => request(app).delete(`/api/tasks/task-b/attachments/${encodeURIComponent(key)}`);
  beforeEach(() => {
    mockGetTaskById.mockResolvedValue({ ...taskB(), attachments: [{ key: ATT_KEY, name: 'note.png' }] });
    mockDeleteAttachment.mockResolvedValue(undefined);
  });

  it("another account's object key is refused with 404 and nothing is deleted", async () => {
    const res = await delAtt(FOREIGN_ATT_KEY);
    expect(res.status).toBe(404);
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
  });

  it('a listed attachment is deleted', async () => {
    const res = await delAtt(ATT_KEY);
    expect(res.status).toBe(204);
    expect(mockDeleteAttachment).toHaveBeenCalledWith('task-b', ATT_KEY);
  });

  it('a task with no attachments refuses any key', async () => {
    mockGetTaskById.mockResolvedValue({ ...taskB() });
    expect((await delAtt(ATT_KEY)).status).toBe(404);
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
  });

  it("someone else's task is still a 403 first", async () => {
    currentUserId = 'user-x';
    expect((await delAtt(ATT_KEY)).status).toBe(403);
    expect(mockDeleteAttachment).not.toHaveBeenCalled();
  });
});
