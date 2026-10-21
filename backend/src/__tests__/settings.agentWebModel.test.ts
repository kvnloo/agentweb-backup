/**
 * ENG-669 PR-C: a setting whose value is the AgentWeb Model id would make a per-turn router a configured model (a
 * default that stands in when nothing was chosen, a role's model): refused with 400, nothing stored. Any other value is
 * stored as before.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'admin-1', email: 'a@x.test', isAdmin: true }; next(); },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
const mockSetSetting = jest.fn(async (name: string, value: unknown) => ({ settingName: name, settingValue: value }));
jest.mock('../services/settingsService', () => ({ settingsService: { setSetting: (...a: [string, unknown]) => mockSetSetting(...a), getSetting: jest.fn() } }));
jest.mock('../services/db', () => ({ userDb: {}, orgDb: {} }));
jest.mock('../services/linkedInOutreachService', () => ({ linkedInOutreachService: {} }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../services/orgShareService', () => ({ canEditItem: jest.fn(), canViewItem: jest.fn() }));

import settingsRoutes from '../routes/settings';

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRoutes);

beforeEach(() => mockSetSetting.mockClear());

it('refuses the AgentWeb Model as a configured model (e.g. the default model setting)', async () => {
  for (const settingValue of ['agentweb-model', ' agentweb-model ']) {
    const res = await request(app).put('/api/settings/agent_mode_default_model').send({ settingValue });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('agentweb_model_not_configurable');
  }
  expect(mockSetSetting).not.toHaveBeenCalled();
});

it('stores any other value as before', async () => {
  const res = await request(app).put('/api/settings/agent_mode_default_model').send({ settingValue: 'gemini-3.8-flash' });
  expect(res.status).toBe(200);
  expect(mockSetSetting).toHaveBeenCalledWith('agent_mode_default_model', 'gemini-3.8-flash', undefined, 'a@x.test');
});

it('POST /api/settings (create) refuses it the same way', async () => {
  const res = await request(app).post('/api/settings').send({ settingName: 'agent_mode_default_model', settingValue: 'agentweb-model' });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('agentweb_model_not_configurable');
  expect(mockSetSetting).not.toHaveBeenCalled();
  const ok = await request(app).post('/api/settings').send({ settingName: 'agent_mode_default_model', settingValue: 'gemini-3.8-flash' });
  expect(ok.status).toBe(200);
});
