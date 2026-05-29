/**
 * Tests for the dedicated vision model used by the describe_image tool.
 * describe_image is a vision utility — it must resolve its model from
 * agent_mode_vision_model (getVisionModel), independent of the chat/default model.
 */

import { AgentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';

jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(),
      scan: jest.fn(), query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - vision model (describe_image)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('getVisionModel()', () => {
    it('returns the admin-configured vision model when valid', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: 'gemini-3-flash-preview' });
      expect(await service.getVisionModel()).toBe('gemini-3-flash-preview');
    });

    it('falls back to claude-opus-4-8 when no setting exists', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
      expect(await service.getVisionModel()).toBe('claude-opus-4-8');
    });

    it('falls back when the configured model is not in the registry', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: 'not-a-real-model' });
      expect(await service.getVisionModel()).toBe('claude-opus-4-8');
    });

    it('falls back when the setting lookup throws', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('boom'));
      expect(await service.getVisionModel()).toBe('claude-opus-4-8');
    });

    it('does NOT consult the chat/default model setting', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({ settingValue: 'gpt-5.5' });
      await service.getVisionModel();
      // Only the vision setting key should be read
      expect(settingsService.getSetting).toHaveBeenCalledWith('agent_mode_vision_model');
      expect(settingsService.getSetting).not.toHaveBeenCalledWith('agent_mode_default_model');
    });
  });

  describe('getVisionModelOptions()', () => {
    it('excludes the Live (voice) model', async () => {
      const opts = await service.getVisionModelOptions(true);
      expect(opts).not.toContain('gemini-3.1-flash-live-preview');
      expect(opts.length).toBeGreaterThan(0);
    });

    it('includes verified multimodal models (GPT, Gemini, Claude Bedrock/Vertex)', async () => {
      const opts = await service.getVisionModelOptions(true);
      expect(opts).toContain('gpt-5-chat-2');
      expect(opts).toContain('gpt-5.4-nano');
      expect(opts).toContain('gemini-3-flash-preview');
      expect(opts).toContain('anthropic.claude-sonnet-4-6');
      expect(opts).toContain('claude-opus-4-8');
    });

    it('excludes models that fail the vision probe (unserved id / unprovisioned account)', async () => {
      const opts = await service.getVisionModelOptions(true);
      // Gemini API returns 404 for this id
      expect(opts).not.toContain('gemini-3-pro-preview');
      // Not provisioned on the Bedrock account (403)
      expect(opts).not.toContain('anthropic.claude-opus-4-7');
    });

    it('only returns models flagged supportsVision', async () => {
      const opts = await service.getVisionModelOptions(true);
      const allModels = await service.getSupportedModels(true);
      // Every returned option must be a real registered model
      opts.forEach(m => expect(allModels).toContain(m));
    });

    it('hides admin-only models from non-admin callers', async () => {
      const adminOpts = await service.getVisionModelOptions(true);
      const userOpts = await service.getVisionModelOptions(false);
      // Opus 4.6 (Bedrock) is admin-only in the registry
      expect(adminOpts).toContain('anthropic.claude-opus-4-6-v1');
      expect(userOpts).not.toContain('anthropic.claude-opus-4-6-v1');
    });
  });

  describe('describeImage() model resolution', () => {
    it('uses getVisionModel (not getDefaultModel) when no model is passed', async () => {
      const visionSpy = jest.spyOn(service, 'getVisionModel').mockResolvedValue('gemini-3-flash-preview');
      const defaultSpy = jest.spyOn(service, 'getDefaultModel').mockResolvedValue('claude-opus-4-8');
      const callLLMSpy = jest
        .spyOn(service, 'callLLM')
        .mockResolvedValue({ choices: [{ message: { content: 'ok' } }] } as any);

      await service.describeImage(undefined, 'data:image/png;base64,iVBORw0KGgo=');

      expect(visionSpy).toHaveBeenCalled();
      expect(defaultSpy).not.toHaveBeenCalled();
      // describeImage forwards the resolved vision model to callLLM
      expect(callLLMSpy.mock.calls[0][0]).toBe('gemini-3-flash-preview');
    });
  });
});
