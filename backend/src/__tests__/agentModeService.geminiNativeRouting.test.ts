/**
 * ENG-737 wiring test: the kill-switch that routes gemini agent calls to the native
 * @google/genai adapter (leak-free) vs the OpenAI-compat client. The pure adapter is
 * covered in geminiNativeClient.test.ts; this pins getGeminiAgentClient's routing,
 * the AW-Settings/env override, TTL caching, and fail-open behaviour — the exact
 * end-to-end surface a prior review flagged as untested for the previous fix.
 */

import { AgentModeService } from '../services/agentModeService';

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

const mockSettingsService = require('../services/settingsService');

function setSetting(getSetting: jest.Mock) {
  mockSettingsService.settingsService = { getSetting };
}

describe('ENG-737 getGeminiAgentClient kill-switch routing', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GEMINI_NATIVE_ADAPTER;
    service = new AgentModeService();
  });

  afterEach(() => {
    delete process.env.GEMINI_NATIVE_ADAPTER;
  });

  it('defaults ON (no setting) → routes to the native adapter', async () => {
    setSetting(jest.fn().mockResolvedValue(null));
    const compatSpy = jest.spyOn(service, 'getGeminiClient');
    const client = await service.getGeminiAgentClient();
    expect(client).toBe(service.getGeminiNativeClient());
    expect(compatSpy).not.toHaveBeenCalled();
  });

  it('AW-Settings "false" → falls back to the compat client', async () => {
    setSetting(jest.fn().mockResolvedValue({ settingValue: 'false' }));
    const fakeCompat = { chat: { completions: { create: jest.fn() } } } as any;
    jest.spyOn(service, 'getGeminiClient').mockResolvedValue(fakeCompat);
    const client = await service.getGeminiAgentClient();
    expect(client).toBe(fakeCompat);
  });

  it('env override GEMINI_NATIVE_ADAPTER=0 wins over an ON setting', async () => {
    process.env.GEMINI_NATIVE_ADAPTER = '0';
    const getSetting = jest.fn().mockResolvedValue({ settingValue: 'true' });
    setSetting(getSetting);
    const fakeCompat = { chat: { completions: { create: jest.fn() } } } as any;
    jest.spyOn(service, 'getGeminiClient').mockResolvedValue(fakeCompat);
    const client = await service.getGeminiAgentClient();
    expect(client).toBe(fakeCompat);
    // env short-circuits before any settings read
    expect(getSetting).not.toHaveBeenCalled();
  });

  it('TTL-caches the flag read (one settings hit for two calls)', async () => {
    const getSetting = jest.fn().mockResolvedValue({ settingValue: 'true' });
    setSetting(getSetting);
    await service.getGeminiAgentClient();
    await service.getGeminiAgentClient();
    expect(getSetting).toHaveBeenCalledTimes(1);
  });

  it('fails open to native when the settings read throws', async () => {
    setSetting(jest.fn().mockRejectedValue(new Error('dynamo down')));
    const compatSpy = jest.spyOn(service, 'getGeminiClient');
    const client = await service.getGeminiAgentClient();
    expect(client).toBe(service.getGeminiNativeClient());
    expect(compatSpy).not.toHaveBeenCalled();
  });

  it('getGeminiNativeClient caches a single wrapper instance', () => {
    expect(service.getGeminiNativeClient()).toBe(service.getGeminiNativeClient());
  });
});
