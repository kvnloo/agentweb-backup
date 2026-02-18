import request from 'supertest';
import express from 'express';
import settingsRoutes from '../routes/settings';

// Mock auth middleware so we always act as an authenticated user
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    setSetting: jest.fn(),
    getSetting: jest.fn(),
    getSettingsByPrefix: jest.fn(),
  },
}));

import { settingsService } from '../services/settingsService';

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

let app: express.Application;

describe('POST /api/settings/replay-sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes);
  });

  it('should save replay session with correct URL format', async () => {
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/settings/replay-sessions')
      .send({ clarityProjectId: 'proj123', trackingUserId: 'user-456' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.replayUrl).toBe(
      'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-456'
    );

    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      'replay_sessions_user-456',
      expect.stringContaining('"replayUrl"'),
      'Clarity replay session link',
      'test@example.com'
    );

    // Verify the stored JSON value
    const storedValue = JSON.parse(mockSettingsService.setSetting.mock.calls[0][1]);
    expect(storedValue).toEqual({
      replayUrl: 'https://clarity.microsoft.com/projects/view/proj123/impressions?CustomUserId=is%3Buser-456',
      clarityProjectId: 'proj123',
      trackingUserId: 'user-456',
      lastTracked: expect.any(String),
    });
  });

  it('should return 400 when clarityProjectId is missing', async () => {
    const res = await request(app)
      .post('/api/settings/replay-sessions')
      .send({ trackingUserId: 'user-456' })
      .expect(400);

    expect(res.body.error).toBe('clarityProjectId and trackingUserId are required');
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('should return 400 when trackingUserId is missing', async () => {
    const res = await request(app)
      .post('/api/settings/replay-sessions')
      .send({ clarityProjectId: 'proj123' })
      .expect(400);

    expect(res.body.error).toBe('clarityProjectId and trackingUserId are required');
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('should return 500 when settingsService fails', async () => {
    mockSettingsService.setSetting.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .post('/api/settings/replay-sessions')
      .send({ clarityProjectId: 'proj123', trackingUserId: 'user-456' })
      .expect(500);

    expect(res.body.error).toBe('Failed to save replay session');
  });

  it('should use trackingUserId in the setting name key', async () => {
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    await request(app)
      .post('/api/settings/replay-sessions')
      .send({ clarityProjectId: 'myproj', trackingUserId: '1738251317419' })
      .expect(200);

    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      'replay_sessions_1738251317419',
      expect.any(String),
      'Clarity replay session link',
      'test@example.com'
    );
  });
});
