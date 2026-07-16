import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';

// Mock dependencies
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
    getAllUsers: jest.fn(),
  },
}));
jest.mock('../services/waitlistDb', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/workflowDb', () => ({}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-user-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
}));
jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('aws-sdk', () => ({
  default: {
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
      }),
    })),
  },
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ SecretString: 'test-secret' }),
    }),
  })),
}));

import { userDb } from '../services/db';
import { settingsService } from '../services/settingsService';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockSettings = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const existingUser = { userId: 'user-1', email: 'user1@test.com', isAdmin: false, isActive: true };

// Helper: build a fake stored notes setting
function makeNotesSetting(notes: any[]) {
  return { settingName: 'usernote_user-1', settingValue: JSON.stringify(notes), updatedAt: '', updatedBy: '' };
}

describe('GET /api/admin/users/:userId/notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app).get('/api/admin/users/nonexistent/notes');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('returns empty notes array when no notes stored yet', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockSettings.getSetting.mockResolvedValue(null);
    const res = await request(app).get('/api/admin/users/user-1/notes');
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  it('returns notes sorted newest first', async () => {
    const notes = [
      { id: 'a', content: 'first', timestamp: '2026-04-01T10:00:00Z', authorEmail: 'admin@example.com' },
      { id: 'b', content: 'second', timestamp: '2026-04-02T10:00:00Z', authorEmail: 'admin@example.com' },
    ];
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockSettings.getSetting.mockResolvedValue(makeNotesSetting(notes));
    const res = await request(app).get('/api/admin/users/user-1/notes');
    expect(res.status).toBe(200);
    expect(res.body.notes[0].id).toBe('b'); // newest first
    expect(res.body.notes[1].id).toBe('a');
  });
});

describe('POST /api/admin/users/:userId/notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app)
      .post('/api/admin/users/nonexistent/notes')
      .send({ content: 'hello' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when content is missing', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    const res = await request(app).post('/api/admin/users/user-1/notes').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('content is required');
  });

  it('returns 400 when content is blank', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    const res = await request(app).post('/api/admin/users/user-1/notes').send({ content: '   ' });
    expect(res.status).toBe(400);
  });

  it('successfully adds a note and returns notes newest first', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockSettings.getSetting.mockResolvedValue(null); // no existing notes
    mockSettings.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/admin/users/user-1/notes')
      .send({ content: 'Test note content' });

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].content).toBe('Test note content');
    expect(res.body.notes[0].authorEmail).toBe('admin@example.com');
    expect(mockSettings.setSetting).toHaveBeenCalledWith(
      'usernote_user-1',
      expect.any(String),
      expect.any(String),
      'admin@example.com'
    );
  });

  it('drops the oldest note and includes warning when limit exceeded', async () => {
    // Build 50 notes (already at max) with timestamps well in the past
    const baseTime = new Date('2025-01-01T00:00:00Z').getTime();
    const existingNotes = Array.from({ length: 50 }, (_, i) => ({
      id: `note-${i}`,
      content: `Note ${i}`,
      timestamp: new Date(baseTime + i * 1000).toISOString(),
      authorEmail: 'admin@example.com',
    }));
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockSettings.getSetting.mockResolvedValue(makeNotesSetting(existingNotes));
    mockSettings.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/admin/users/user-1/notes')
      .send({ content: 'The 51st note' });

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(50); // still capped at 50
    expect(res.body.warning).toMatch(/Limit of 50 notes reached/);
    // The newest note should be first (the one we just added)
    expect(res.body.notes[0].content).toBe('The 51st note');
  });
});

describe('PUT /api/admin/users/:userId/funnel-status', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);

    const res = await request(app)
      .put('/api/admin/users/nonexistent/funnel-status')
      .send({ funnelStatus: 'account_setup' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('returns 400 when funnelStatus is not a string or null', async () => {
    const res = await request(app)
      .put('/api/admin/users/user-1/funnel-status')
      .send({ funnelStatus: ['account_setup'] });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('funnelStatus must be a string or null');
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  it('returns 400 when funnelStatus is too long', async () => {
    const res = await request(app)
      .put('/api/admin/users/user-1/funnel-status')
      .send({ funnelStatus: 'x'.repeat(81) });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('funnelStatus must be 80 characters or fewer');
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  it('saves a trimmed funnel status', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({
      ...existingUser,
      funnelStatus: 'evaluation_period',
    } as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/funnel-status')
      .send({ funnelStatus: ' evaluation_period ' });

    expect(res.status).toBe(200);
    expect(res.body.funnelStatus).toBe('evaluation_period');
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', {
      funnelStatus: 'evaluation_period',
    });
  });

  it('clears funnel status when blank', async () => {
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockUserDb.updateUser.mockResolvedValue({
      ...existingUser,
      funnelStatus: null,
    } as any);

    const res = await request(app)
      .put('/api/admin/users/user-1/funnel-status')
      .send({ funnelStatus: '   ' });

    expect(res.status).toBe(200);
    expect(res.body.funnelStatus).toBeNull();
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user-1', {
      funnelStatus: null,
    });
  });
});

describe('DELETE /api/admin/users/:userId/notes/:noteId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when user does not exist', async () => {
    mockUserDb.getUserById.mockResolvedValue(null as any);
    const res = await request(app).delete('/api/admin/users/nonexistent/notes/note-1');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('User not found');
  });

  it('returns 404 when note id does not exist', async () => {
    const notes = [
      { id: 'existing-note', content: 'hi', timestamp: '2026-04-01T10:00:00Z', authorEmail: 'admin@example.com' },
    ];
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockSettings.getSetting.mockResolvedValue(makeNotesSetting(notes));

    const res = await request(app).delete('/api/admin/users/user-1/notes/wrong-id');
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Note not found');
  });

  it('successfully deletes a note and returns remaining notes', async () => {
    const notes = [
      { id: 'note-a', content: 'Keep', timestamp: '2026-04-02T10:00:00Z', authorEmail: 'admin@example.com' },
      { id: 'note-b', content: 'Delete me', timestamp: '2026-04-01T10:00:00Z', authorEmail: 'admin@example.com' },
    ];
    mockUserDb.getUserById.mockResolvedValue(existingUser as any);
    mockSettings.getSetting.mockResolvedValue(makeNotesSetting(notes));
    mockSettings.setSetting.mockResolvedValue({} as any);

    const res = await request(app).delete('/api/admin/users/user-1/notes/note-b');
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0].id).toBe('note-a');
  });
});
