import request from 'supertest';
import express from 'express';
import settingsRoutes from '../routes/settings';

// Mock auth middleware — admin by default
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Mock settingsService — import the real isUserScopedSetting for filtering
jest.mock('../services/settingsService', () => {
  const actual = jest.requireActual('../services/settingsService');
  return {
    settingsService: {
      setSetting: jest.fn(),
      getSetting: jest.fn(),
      getAllSettings: jest.fn(),
      getGlobalSettings: jest.fn(),
    },
    isUserScopedSetting: actual.isUserScopedSetting,
  };
});

// Mock userDb (needed for some routes)
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { settingsService } from '../services/settingsService';

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

let app: express.Application;

const MOCK_ALL_SETTINGS = [
  // Global settings (should always be returned)
  { settingName: 'agent_mode_system_prompt', settingValue: 'You are helpful', updatedAt: '2026-01-01', updatedBy: 'admin' },
  { settingName: 'agent-mode-predefined-workplans', settingValue: '[]', updatedAt: '2026-01-01', updatedBy: 'admin' },
  { settingName: 'slack_channel_mapping', settingValue: '{}', updatedAt: '2026-01-01', updatedBy: 'admin' },
  { settingName: 'email_templates_public', settingValue: '[]', updatedAt: '2026-01-01', updatedBy: 'admin' },
  // User-scoped settings (should be filtered out by default)
  { settingName: 'email_templates_user-abc', settingValue: '[{"template":"private"}]', updatedAt: '2026-01-01', updatedBy: 'user@example.com' },
  { settingName: 'email_templates_user-def', settingValue: '[{"template":"other-private"}]', updatedAt: '2026-01-01', updatedBy: 'other@example.com' },
  { settingName: 'replay_sessions_user-abc', settingValue: '{"replayUrl":"https://clarity..."}', updatedAt: '2026-01-01', updatedBy: 'user@example.com' },
  { settingName: 'replay_sessions_user-def', settingValue: '{"replayUrl":"https://clarity..."}', updatedAt: '2026-01-01', updatedBy: 'other@example.com' },
  { settingName: 'user-abc-email_campaign_tasks', settingValue: '{}', updatedAt: '2026-01-01', updatedBy: 'user@example.com' },
  { settingName: 'user-def-email_campaign_tasks', settingValue: '{}', updatedAt: '2026-01-01', updatedBy: 'other@example.com' },
  { settingName: 'crm_sender_emails', settingValue: '{"employees":[]}', updatedAt: '2026-01-01', updatedBy: 'admin' },
  { settingName: 'funnels_user-abc', settingValue: '{}', updatedAt: '2026-01-01', updatedBy: 'user@example.com' },
];

describe('GET /api/settings — cross-user data leakage fix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes);

    // Mock getGlobalSettings to return only non-user-scoped settings (simulates real filtering)
    const { isUserScopedSetting } = jest.requireActual('../services/settingsService');
    mockSettingsService.getGlobalSettings.mockResolvedValue(
      MOCK_ALL_SETTINGS.filter((s: any) => !isUserScopedSetting(s.settingName)) as any
    );
  });

  // --- FAIL TESTS ---

  it('should NOT return user-scoped email_templates settings by default', async () => {
    const res = await request(app).get('/api/settings').expect(200);

    const names = res.body.map((s: any) => s.settingName);
    expect(names).not.toContain('email_templates_user-abc');
    expect(names).not.toContain('email_templates_user-def');
    // Public templates are global, should still be returned
    expect(names).toContain('email_templates_public');
  });

  it('should NOT return user-scoped replay_sessions settings by default', async () => {
    const res = await request(app).get('/api/settings').expect(200);

    const names = res.body.map((s: any) => s.settingName);
    expect(names).not.toContain('replay_sessions_user-abc');
    expect(names).not.toContain('replay_sessions_user-def');
  });

  it('should NOT return user-scoped email_campaign_tasks settings by default', async () => {
    const res = await request(app).get('/api/settings').expect(200);

    const names = res.body.map((s: any) => s.settingName);
    expect(names).not.toContain('user-abc-email_campaign_tasks');
    expect(names).not.toContain('user-def-email_campaign_tasks');
  });

  it('should NOT return user-scoped funnels settings by default', async () => {
    const res = await request(app).get('/api/settings').expect(200);

    const names = res.body.map((s: any) => s.settingName);
    expect(names).not.toContain('funnels_user-abc');
  });

  // --- SUCCESS TESTS ---

  it('should return only global/system settings by default', async () => {
    const res = await request(app).get('/api/settings').expect(200);

    const names = res.body.map((s: any) => s.settingName);
    // Global settings should be present
    expect(names).toContain('agent_mode_system_prompt');
    expect(names).toContain('agent-mode-predefined-workplans');
    expect(names).toContain('slack_channel_mapping');
    expect(names).toContain('email_templates_public');
    expect(names).toContain('crm_sender_emails');

    // No user-scoped settings
    const userScoped = names.filter((n: string) =>
      /^email_templates_(?!public)/.test(n) ||
      /^replay_sessions_/.test(n) ||
      /^user-.+-email_campaign_tasks$/.test(n) ||
      /^funnels_/.test(n)
    );
    expect(userScoped).toHaveLength(0);
  });

  it('should return global settings count less than total settings count', async () => {
    const res = await request(app).get('/api/settings').expect(200);

    // Total mock settings = 12, user-scoped = 7 (2 email_templates + 2 replay + 2 campaign + 1 funnels)
    // Global = 5 (system_prompt + workplans + slack + email_public + crm_sender)
    expect(res.body.length).toBe(5);
    expect(res.body.length).toBeLessThan(MOCK_ALL_SETTINGS.length);
  });
});
