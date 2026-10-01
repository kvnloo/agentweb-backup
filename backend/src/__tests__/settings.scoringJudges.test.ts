import request from 'supertest';
import express from 'express';
import settingsRoutes from '../routes/settings';
import { settingsService } from '../services/settingsService';

// Minimal shape for asserting against a stored/parsed scoring-judges row in the CAS-retry
// tests below — just enough fields to check id/name without reaching for `any`.
type StoredJudge = { id: string; name: string; [key: string]: unknown };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', email: 'admin@example.com', isAdmin: true };
    next();
  },
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    setSettingIfValueMatches: jest.fn(),
    deleteSetting: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({ userDb: {} }));
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: { checkAccountConnectivity: jest.fn() },
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn().mockResolvedValue([
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-flash-live-preview',
    ]),
    llmModels: {
      'gemini-3.1-flash-lite': { isLive: false },
      'gemini-3.5-flash': { isLive: false },
      'gemini-3.1-flash-live-preview': { isLive: true },
    },
  },
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRoutes);

afterEach(() => jest.clearAllMocks());

describe('GET /api/settings/scoring-judges', () => {
  it('returns judges and available models, filtering out live models', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify([{ id: 'j1', name: 'A', systemPrompt: 'p', llmModel: 'gemini-3.5-flash' }]),
      description: '',
      updatedBy: 'admin@example.com',
      updatedAt: new Date().toISOString(),
    });

    const res = await request(app).get('/api/settings/scoring-judges');

    expect(res.status).toBe(200);
    expect(res.body.judges).toHaveLength(1);
    expect(res.body.availableModels).toContain('gemini-3.5-flash');
    expect(res.body.availableModels).toContain('gemini-3.1-flash-lite');
    expect(res.body.availableModels).not.toContain('gemini-3.1-flash-live-preview');
  });

  it('returns an empty judges array when nothing is stored', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    const res = await request(app).get('/api/settings/scoring-judges');
    expect(res.status).toBe(200);
    expect(res.body.judges).toEqual([]);
  });
});

describe('POST /api/settings/scoring-judges', () => {
  it('persists llmModel when provided', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Strict', systemPrompt: 'Rate it', llmModel: 'gemini-3.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBe('gemini-3.5-flash');
    expect(res.body.judge.name).toBe('Strict');
  });

  it('omits llmModel when not provided', async () => {
    mockSettingsService.getSetting.mockResolvedValue(null);
    mockSettingsService.setSetting.mockResolvedValue({} as any);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Lenient', systemPrompt: 'Rate it' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBeUndefined();
  });

  it('returns 400 when name or systemPrompt missing', async () => {
    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'NoPrompt' });
    expect(res.status).toBe(400);
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('creating a genuinely new judge (no id collision) still works as before', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify([{ id: 'j1', name: 'A', systemPrompt: 'p', createdAt: 't', updatedAt: 't' }]),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    mockSettingsService.setSettingIfValueMatches.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Brand New', systemPrompt: 'Rate it' });

    expect(res.status).toBe(200);
    expect(res.body.judge.name).toBe('Brand New');
    expect(res.body.judge.shadow).toBeUndefined();
    expect(res.body.judge.sampleRate).toBeUndefined();
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
    const stored = JSON.parse(mockSettingsService.setSettingIfValueMatches.mock.calls[0][1]);
    expect(stored).toHaveLength(2);
  });

  it('rejects POST with an id that already exists instead of silently dropping fields (ENG-2218)', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify([
        {
          id: 'outcome-judge-b-shadow',
          name: 'Outcome Judge (shadow)',
          systemPrompt: 'rubric b',
          llmModel: 'anthropic.claude-sonnet-4-6',
          shadow: true,
          sampleRate: 0.33,
          createdAt: 't',
          updatedAt: 't',
        },
      ]),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    mockSettingsService.setSettingIfValueMatches.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ id: 'outcome-judge-b-shadow', name: 'Outcome Judge (shadow)', systemPrompt: 'rubric b' });

    expect(res.status).toBe(409);
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
    expect(mockSettingsService.setSettingIfValueMatches).not.toHaveBeenCalled();
  });

  it('ENG-2223: retries the create once against a fresh read after a CAS conflict, then succeeds', async () => {
    const v0 = JSON.stringify([{ id: 'j1', name: 'A', systemPrompt: 'p', createdAt: 't', updatedAt: 't' }]);
    // Simulates another admin's save landing between this request's read and its write: the
    // first getSetting-in-attempt read is stale (v0), the retry's read sees the row another
    // writer already advanced to (v1, with a second judge j2 that must survive).
    const v1 = JSON.stringify([
      { id: 'j1', name: 'A', systemPrompt: 'p', createdAt: 't', updatedAt: 't' },
      { id: 'j2', name: 'B (from other writer)', systemPrompt: 'p2', createdAt: 't', updatedAt: 't' },
    ]);
    mockSettingsService.getSetting
      .mockResolvedValueOnce({ settingName: 'scoring-judges', settingValue: v0, description: '', updatedBy: 'a', updatedAt: 't' })
      .mockResolvedValueOnce({ settingName: 'scoring-judges', settingValue: v1, description: '', updatedBy: 'a', updatedAt: 't' });

    const conflict = Object.assign(new Error('conditional check failed'), {
      code: 'ConditionalCheckFailedException',
    });
    mockSettingsService.setSettingIfValueMatches
      .mockRejectedValueOnce(conflict) // first attempt: conditioned on stale v0, loses the race
      .mockResolvedValueOnce(undefined); // retry: conditioned on fresh v1, succeeds

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Brand New', systemPrompt: 'Rate it' });

    expect(res.status).toBe(200);
    expect(res.body.judge.name).toBe('Brand New');
    expect(mockSettingsService.setSettingIfValueMatches).toHaveBeenCalledTimes(2);

    // First attempt was conditioned on the stale value it read.
    expect(mockSettingsService.setSettingIfValueMatches.mock.calls[0][2]).toBe(v0);
    // Retry re-read fresh and is conditioned on THAT value, not the stale one.
    expect(mockSettingsService.setSettingIfValueMatches.mock.calls[1][2]).toBe(v1);
    // The retry's payload preserves the concurrent writer's j2 alongside the new judge — the
    // CAS retry never silently drops the other writer's change.
    const finalStored = JSON.parse(mockSettingsService.setSettingIfValueMatches.mock.calls[1][1]) as StoredJudge[];
    expect(finalStored.map((j) => j.id)).toEqual(expect.arrayContaining(['j1', 'j2']));
    expect(finalStored.find((j) => j.name === 'B (from other writer)')).toBeDefined();
    expect(finalStored.find((j) => j.name === 'Brand New')).toBeDefined();
    expect(finalStored).toHaveLength(3);
  });

  it('ENG-2223: fails loudly instead of looping forever when CAS conflicts exceed the retry budget', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify([{ id: 'j1', name: 'A', systemPrompt: 'p', createdAt: 't', updatedAt: 't' }]),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    const conflict = Object.assign(new Error('conditional check failed'), {
      code: 'ConditionalCheckFailedException',
    });
    mockSettingsService.setSettingIfValueMatches.mockRejectedValue(conflict);

    const res = await request(app)
      .post('/api/settings/scoring-judges')
      .send({ name: 'Contended', systemPrompt: 'Rate it' });

    expect(res.status).toBe(500);
    // Bounded — same retry budget as the codebase's other setSettingIfValueMatches caller
    // (htmlTemplateService.upsertPublicTemplate's MAX_ATTEMPTS = 5), never an infinite loop.
    expect(mockSettingsService.setSettingIfValueMatches).toHaveBeenCalledTimes(5);
  });
});

describe('PUT /api/settings/scoring-judges/:judgeId', () => {
  const existing = [{ id: 'j1', name: 'A', systemPrompt: 'p', llmModel: 'gemini-3.5-flash', createdAt: 't', updatedAt: 't' }];

  it('updates llmModel when provided', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    mockSettingsService.setSettingIfValueMatches.mockResolvedValue(undefined);

    const res = await request(app)
      .put('/api/settings/scoring-judges/j1')
      .send({ llmModel: 'gemini-3.1-flash-lite' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBe('gemini-3.1-flash-lite');
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it('clears llmModel when an empty string is sent', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    mockSettingsService.setSettingIfValueMatches.mockResolvedValue(undefined);

    const res = await request(app)
      .put('/api/settings/scoring-judges/j1')
      .send({ llmModel: '' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBeUndefined();
  });

  it('returns 404 for an unknown judge id', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    const res = await request(app)
      .put('/api/settings/scoring-judges/does-not-exist')
      .send({ llmModel: 'gemini-3.5-flash' });
    expect(res.status).toBe(404);
  });

  it('ENG-2218: updating an existing shadow judge preserves shadow/sampleRate unchanged', async () => {
    const shadowJudge = {
      id: 'outcome-judge-b-shadow',
      name: 'Outcome Judge (shadow)',
      systemPrompt: 'old rubric b prompt',
      llmModel: 'anthropic.claude-sonnet-4-6',
      shadow: true,
      sampleRate: 0.33,
      createdAt: 't0',
      updatedAt: 't0',
    };
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify([shadowJudge]),
      description: '', updatedBy: 'a', updatedAt: 't0',
    });
    mockSettingsService.setSettingIfValueMatches.mockResolvedValue(undefined);

    const res = await request(app)
      .put('/api/settings/scoring-judges/outcome-judge-b-shadow')
      .send({ name: 'Outcome Judge (shadow) renamed', systemPrompt: 'updated rubric b prompt' });

    expect(res.status).toBe(200);
    expect(res.body.judge.name).toBe('Outcome Judge (shadow) renamed');
    expect(res.body.judge.systemPrompt).toBe('updated rubric b prompt');
    // The fields this form never sends must survive untouched.
    expect(res.body.judge.shadow).toBe(true);
    expect(res.body.judge.sampleRate).toBe(0.33);
    expect(res.body.judge.id).toBe('outcome-judge-b-shadow');

    // Also assert what was actually persisted, not just the response.
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
    const stored = JSON.parse(mockSettingsService.setSettingIfValueMatches.mock.calls[0][1]);
    expect(stored).toHaveLength(1);
    expect(stored[0].shadow).toBe(true);
    expect(stored[0].sampleRate).toBe(0.33);
  });

  it('ENG-2223: a concurrent edit (CAS conflict) retries against the fresh row and preserves both changes', async () => {
    // Two admins editing DIFFERENT judges in the same stored array at nearly the same time.
    // v0 is what this request reads first; v1 is what the row actually looks like by the time
    // this request's write is attempted, because another admin's edit to judge j-other landed
    // first and advanced the row's raw settingValue.
    const v0 = JSON.stringify([
      { ...existing[0] },
      { id: 'j-other', name: 'Other', systemPrompt: 'op', createdAt: 't', updatedAt: 't' },
    ]);
    const v1 = JSON.stringify([
      { ...existing[0] },
      { id: 'j-other', name: 'Other (renamed by concurrent admin)', systemPrompt: 'op', createdAt: 't', updatedAt: 't2' },
    ]);
    mockSettingsService.getSetting
      .mockResolvedValueOnce({ settingName: 'scoring-judges', settingValue: v0, description: '', updatedBy: 'a', updatedAt: 't' })
      .mockResolvedValueOnce({ settingName: 'scoring-judges', settingValue: v1, description: '', updatedBy: 'a', updatedAt: 't2' });

    const conflict = Object.assign(new Error('conditional check failed'), {
      code: 'ConditionalCheckFailedException',
    });
    mockSettingsService.setSettingIfValueMatches
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(undefined);

    const res = await request(app)
      .put('/api/settings/scoring-judges/j1')
      .send({ llmModel: 'gemini-3.1-flash-lite' });

    expect(res.status).toBe(200);
    expect(res.body.judge.llmModel).toBe('gemini-3.1-flash-lite');
    expect(mockSettingsService.setSettingIfValueMatches).toHaveBeenCalledTimes(2);

    const finalStored = JSON.parse(mockSettingsService.setSettingIfValueMatches.mock.calls[1][1]) as StoredJudge[];
    const j1 = finalStored.find((j) => j.id === 'j1');
    const jOther = finalStored.find((j) => j.id === 'j-other');
    expect(j1).toBeDefined();
    expect(jOther).toBeDefined();
    // This request's own change was applied...
    expect(j1?.llmModel).toBe('gemini-3.1-flash-lite');
    // ...and the concurrent admin's change to the OTHER judge, picked up on the retry's fresh
    // read, was never clobbered.
    expect(jOther?.name).toBe('Other (renamed by concurrent admin)');
  });

  it('ENG-2223: fails loudly instead of silently dropping the update when retries are exhausted', async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: 'scoring-judges',
      settingValue: JSON.stringify(existing),
      description: '', updatedBy: 'a', updatedAt: 't',
    });
    const conflict = Object.assign(new Error('conditional check failed'), {
      code: 'ConditionalCheckFailedException',
    });
    mockSettingsService.setSettingIfValueMatches.mockRejectedValue(conflict);

    const res = await request(app)
      .put('/api/settings/scoring-judges/j1')
      .send({ llmModel: 'gemini-3.1-flash-lite' });

    expect(res.status).toBe(500);
    expect(mockSettingsService.setSettingIfValueMatches).toHaveBeenCalledTimes(5);
  });
});

describe('default scoring model', () => {
  it('GET default-prompt returns the configured llmModel', async () => {
    mockSettingsService.getSetting.mockImplementation(async (key: string) => {
      if (key === 'default-scoring-prompt') return { settingValue: 'custom prompt' } as any;
      if (key === 'default-scoring-model') return { settingValue: 'gemini-3.5-flash' } as any;
      return null as any;
    });

    const res = await request(app).get('/api/settings/scoring-judges/default-prompt');

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('gemini-3.5-flash');
    expect(res.body.isCustom).toBe(true);
  });

  it('PUT default-prompt persists the llmModel', async () => {
    mockSettingsService.setSetting.mockResolvedValue({} as any);
    mockSettingsService.getSetting.mockResolvedValue({ settingValue: 'gemini-3.5-flash' } as any);

    const res = await request(app)
      .put('/api/settings/scoring-judges/default-prompt')
      .send({ systemPrompt: 'new prompt', llmModel: 'gemini-3.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('gemini-3.5-flash');
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      'default-scoring-model', 'gemini-3.5-flash', expect.any(String), 'admin@example.com'
    );
  });

  it('PUT default-prompt clears the model when llmModel is empty', async () => {
    mockSettingsService.setSetting.mockResolvedValue({} as any);
    mockSettingsService.deleteSetting.mockResolvedValue(undefined as any);
    mockSettingsService.getSetting.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/settings/scoring-judges/default-prompt')
      .send({ systemPrompt: 'new prompt', llmModel: '' });

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('');
    expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('default-scoring-model');
  });

  it('PUT default-prompt returns 400 when systemPrompt missing', async () => {
    const res = await request(app)
      .put('/api/settings/scoring-judges/default-prompt')
      .send({ llmModel: 'gemini-3.5-flash' });
    expect(res.status).toBe(400);
  });

  it('DELETE default-prompt clears both prompt and model', async () => {
    mockSettingsService.deleteSetting.mockResolvedValue(undefined as any);

    const res = await request(app).delete('/api/settings/scoring-judges/default-prompt');

    expect(res.status).toBe(200);
    expect(res.body.llmModel).toBe('');
    expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('default-scoring-prompt');
    expect(mockSettingsService.deleteSetting).toHaveBeenCalledWith('default-scoring-model');
  });
});
