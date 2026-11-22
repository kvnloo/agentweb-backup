jest.mock('../services/db', () => ({ orgDb: { getOrgById: jest.fn(), updateModelRoles: jest.fn() }, userDb: { getUserById: jest.fn() } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
import express from 'express';
import request from 'supertest';
import { orgDb, userDb } from '../services/db';
import { settingsService } from '../services/settingsService';
import { resolveModelForUser, resolveModelForRole, invalidateModelRoles, getRoleDefault, getRoleModelOptions, modelCapabilities, MODEL_ROLES } from '../services/modelRoles';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import router from '../routes/orgModelRoles';
const app = express();
app.use(express.json(), (req, _res, next) => { (req as any).user = { userId: 'u' }; next(); }, router);
beforeEach(() => {
  jest.clearAllMocks();
  invalidateModelRoles('a'); invalidateModelRoles('b');
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: 'a', ownerUserId: 'owner', updatedAt: 'rev', modelRoles: { enrichment: 'gemini-3.8-flash' } });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ orgId: 'a', orgRole: 'admin' });
  (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
});
it('respects overrides and isolates short-lived cache by organization', async () => {
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gemini-3.8-flash');
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: {} });
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gemini-3.8-flash');
  expect(await resolveModelForRole('b', 'enrichment')).toBe('gpt-5.5');
  invalidateModelRoles('a');
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gpt-5.5');
});
it.each(['retired-model', 'gpt-5-chat-2', 'gpt-image-1', {}, [], 42])('falls back for invalid/legacy override %j', async value => {
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: { enrichment: value } });
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gpt-5.5');
});
it('uses a usable supersession successor for a legacy override', async () => {
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: { enrichment: 'gemini-3.7-flash' } });
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gemini-3.8-flash');
});
it('does not use a text successor for a voice role', async () => {
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: { voice: 'gemini-3.7-flash' } });
  expect(await resolveModelForRole('a', 'voice')).toBe('gemini-3.1-flash-live-preview');
});
it('filters role capabilities and restricts embeddings to the existing 1536-dimension space', () => {
  for (const role of MODEL_ROLES) {
    const capability = role === 'image' ? 'image-out' : role === 'embedding' ? 'embedding' : role === 'voice' ? 'live-audio' : 'text';
    expect(getRoleModelOptions(role).length).toBeGreaterThan(0);
    for (const id of getRoleModelOptions(role)) expect(modelCapabilities(id)).toContain(capability);
  }
  expect(getRoleModelOptions('embedding')).toEqual(['openai/text-embedding-3-large']);
  expect(getRoleModelOptions('chat')).not.toContain('openrouter/perplexity/sonar-pro-search');
});
it.each(['get', 'put'])('rejects non-admin %s before touching settings', async method => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ orgId: 'a', orgRole: 'member' });
  expect((await (request(app) as any)[method]('/').send({ modelRoles: {}, revision: 'rev' })).status).toBe(403);
  expect(orgDb.updateModelRoles).not.toHaveBeenCalled();
});
it('returns all eight defaults and persists only the authenticated tenant with a revision', async () => {
  expect((await request(app).get('/')).body.roles).toHaveLength(8);
  (orgDb.updateModelRoles as jest.Mock).mockResolvedValue('next');
  expect((await request(app).put('/').send({ orgId: 'victim', modelRoles: { enrichment: 'gemini-3.8-flash' }, revision: 'rev' })).status).toBe(200);
  expect(orgDb.updateModelRoles).toHaveBeenCalledWith('a', { enrichment: 'gemini-3.8-flash' }, 'rev');
});
it.each([{ unknown: 'x' }, { chat: 'gpt-image-1' }, { image: 4 }, [], { embedding: 'text-embedding-3-small' }, { embedding: 'openai/text-embedding-3-small' }, { embedding: 'openai/text-embedding-ada-002' }])('rejects invalid map %j', async modelRoles => {
  expect((await request(app).put('/').send({ modelRoles, revision: 'rev' })).status).toBe(400);
  expect(orgDb.updateModelRoles).not.toHaveBeenCalled();
});
it('requires a revision, surfaces conflicts and storage errors, and allows reset', async () => {
  expect((await request(app).put('/').send({ modelRoles: {} })).status).toBe(428);
  (orgDb.updateModelRoles as jest.Mock).mockRejectedValueOnce({ code: 'ConditionalCheckFailedException' });
  expect((await request(app).put('/').send({ modelRoles: {}, revision: 'old' })).status).toBe(409);
  (orgDb.updateModelRoles as jest.Mock).mockRejectedValueOnce(new Error('unavailable'));
  expect((await request(app).put('/').send({ modelRoles: {}, revision: 'rev' })).status).toBe(500);
  (orgDb.updateModelRoles as jest.Mock).mockResolvedValueOnce('next');
  expect((await request(app).put('/').send({ modelRoles: {}, revision: 'rev' })).status).toBe(200);
});

it('degrades workload reads on storage failure without caching the failure', async () => {
  (orgDb.getOrgById as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gpt-5.5');
  expect(await resolveModelForRole('a', 'enrichment')).toBe('gemini-3.8-flash');
  (settingsService.getSetting as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  expect(await resolveModelForRole(undefined, 'chat')).toBe('gemini-3.8-flash');
});
it('uses the effective image setting before the older UI default', async () => {
  (settingsService.getSetting as jest.Mock).mockImplementation(async key => ({ settingValue: key === 'agent_mode_image_api_default_model' ? 'gpt-image-2' : 'gpt-image-1' }));
  expect(await resolveModelForRole(undefined, 'image')).toBe('gpt-image-2');
});

it('expires cached org overrides after 15 seconds', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    expect(await resolveModelForRole('a', 'enrichment')).toBe('gemini-3.8-flash');
    (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: {} });
    now.mockReturnValue(16001);
    expect(await resolveModelForRole('a', 'enrichment')).toBe('gpt-5.5');
  } finally { now.mockRestore(); }
});

it('caches membership briefly and never caches lookup failures', async () => {
  expect(await resolveModelForUser('cached-member', 'enrichment')).toBe('gemini-3.8-flash');
  expect(await resolveModelForUser('cached-member', 'enrichment')).toBe('gemini-3.8-flash');
  expect(userDb.getUserById).toHaveBeenCalledTimes(1);
  (userDb.getUserById as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  expect(await resolveModelForUser('retry-member', 'enrichment')).toBe('gpt-5.5');
  expect(await resolveModelForUser('retry-member', 'enrichment')).toBe('gemini-3.8-flash');
  expect(userDb.getUserById).toHaveBeenCalledTimes(3);
});

it.each(['openai/text-embedding-3-large', 'old-azure-deployment', 'openai/text-embedding-3-small'])('resolves embedding override %s to the compatible OpenRouter model', async embedding => {
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: { embedding } });
  expect(await resolveModelForRole('a', 'embedding')).toBe('openai/text-embedding-3-large');
});

describe('persisted admin defaults hidden by the picker (ENG-2183)', () => {
  const setting = (key: string, value: string) => (settingsService.getSetting as jest.Mock)
    .mockImplementation(async (name: string) => (name === key ? { settingValue: value } : null));

  it('honours the preview image alias stored in agent_mode_image_api_default_model', async () => {
    setting('agent_mode_image_api_default_model', 'gemini-3.1-flash-image-preview');
    expect(getRoleModelOptions('image')).not.toContain('gemini-3.1-flash-image-preview');
    expect(await resolveModelForRole(undefined, 'image')).toBe('gemini-3.1-flash-image-preview');
  });

  it('honours a legacy content model stored in agent_mode_content_model', async () => {
    setting('agent_mode_content_model', 'anthropic.claude-opus-4-8');
    expect(getRoleModelOptions('content_generation')).not.toContain('anthropic.claude-opus-4-8');
    expect(await resolveModelForRole(undefined, 'content_generation')).toBe('anthropic.claude-opus-4-8');
  });

  it('maps a renamed model stored under its old id to the new id (alias-aware persisted default)', async () => {
    setting('agent_mode_content_model', 'openrouter/qwen/qwen3.8-max');
    expect(await resolveModelForRole(undefined, 'content_generation')).toBe('openrouter/qwen/qwen3.8-max-0902');
    expect(await getRoleDefault('content_generation')).toBe('openrouter/qwen/qwen3.8-max-0902');
  });

  it.each(['retired-model', 'constructor', 'gpt-image-1'])('falls back for an unknown or wrong-kind content setting %s', async value => {
    setting('agent_mode_content_model', value);
    expect(await resolveModelForRole(undefined, 'content_generation')).toBe('gemini-3.8-flash');
  });

  it('falls back for an unknown image setting', async () => {
    setting('agent_mode_image_api_default_model', 'gemini-3.8-flash');
    expect(await resolveModelForRole(undefined, 'image')).toBe('gemini-3-pro-image-preview');
  });

  it('honours Opus 4.6 stored as the content model: it was the last adminOnly model and is open to everyone now', async () => {
    setting('agent_mode_content_model', 'anthropic.claude-opus-4-6-v1');
    expect(await resolveModelForRole(undefined, 'content_generation')).toBe('anthropic.claude-opus-4-6-v1');
  });

  it('still falls back for a model that IS flagged adminOnly (the mechanism is kept; synthetic entry, none is flagged in the registry)', async () => {
    const id = '__synthetic-admin-only__';
    (LLM_MODEL_REGISTRY as Record<string, unknown>)[id] = { ...LLM_MODEL_REGISTRY['anthropic.claude-opus-4-6-v1'], adminOnly: true };
    try {
      setting('agent_mode_content_model', id);
      expect(await resolveModelForRole(undefined, 'content_generation')).toBe('gemini-3.8-flash');
    } finally {
      delete (LLM_MODEL_REGISTRY as Record<string, unknown>)[id];
    }
  });

  it('falls back for an internalOnly model', async () => {
    setting('agent_mode_default_model', 'openrouter/perplexity/sonar-pro-search');
    expect(await resolveModelForRole(undefined, 'chat')).toBe('gemini-3.8-flash');
  });
});

describe('enrichment keeps its pre-model-roles default (ENG-2184)', () => {
  it('defaults to gpt-5.5, the model gpt-5-chat-2 resolved to, although the picker hides it', async () => {
    expect(getRoleModelOptions('enrichment')).not.toContain('gpt-5.5');
    expect(await getRoleDefault('enrichment')).toBe('gpt-5.5');
    expect(await resolveModelForRole(undefined, 'enrichment')).toBe('gpt-5.5');
    expect(await resolveModelForUser(undefined, 'enrichment')).toBe('gpt-5.5');
  });

  it('reads no admin setting for enrichment', async () => {
    (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: 'gemini-3.8-flash' });
    expect(await getRoleDefault('enrichment')).toBe('gpt-5.5');
    expect(settingsService.getSetting).not.toHaveBeenCalled();
  });

  it.each(MODEL_ROLES)('resolves a default for %s without throwing', async role => {
    await expect(getRoleDefault(role)).resolves.toEqual(expect.any(String));
  });

  it('lets an org override win over the enrichment default', async () => {
    (orgDb.getOrgById as jest.Mock).mockResolvedValue({ modelRoles: { enrichment: 'gemini-3.1-flash-lite' } });
    expect(await resolveModelForRole('a', 'enrichment')).toBe('gemini-3.1-flash-lite');
    expect(await resolveModelForUser('override-member', 'enrichment')).toBe('gemini-3.1-flash-lite');
  });

  it('offers only tool-capable models, which the web-search tier needs', () => {
    for (const id of [...getRoleModelOptions('enrichment'), 'gpt-5.5']) {
      expect(LLM_MODEL_REGISTRY[id].supportsTools).not.toBe(false);
    }
  });
});
