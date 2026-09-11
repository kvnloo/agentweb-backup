import { recordUsage } from '../services/usageRecorderService';
import { getModelPrice } from '../utils/llmPricing';
jest.mock('../services/usageRecorderService', () => ({ recordUsage: jest.fn().mockResolvedValue(undefined) }));
import { runEvaluation } from '../services/evaluationService';
import { evaluationStore } from '../services/evaluationStore';
import { getGeminiClient } from '../utils/llmClients';
import sharp from 'sharp';
import { randomBytes } from 'crypto';

jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn(), reserve: jest.fn(), saveArtifact: jest.fn() } }));
jest.mock('../utils/llmClients', () => ({ getGeminiClient: jest.fn() }));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn().mockResolvedValue('synthetic-provider-fixture') }));
describe('ENG-1870 approved-material-only generation and bounded spend', () => {
  const generateContent = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'active', expiresAt: Date.now() + 60000, materials: [{ title: 'Case', text: 'Approved synthetic metrics', approved: true }] });
    (getGeminiClient as jest.Mock).mockResolvedValue({ models: { generateContent } });
    (evaluationStore.reserve as jest.Mock).mockResolvedValue(undefined);
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'Strategy based on the approved case' }] } }] });
    (evaluationStore.saveArtifact as jest.Mock).mockResolvedValue({ artifactId: 'artifact-test' });
  });
  it('can analyze approved material, without tools, web retrieval, org context, or arbitrary model selection', async () => {
    const result = await runEvaluation('eval_test', { action: 'analyze', prompt: 'Propose a strategy' });
    expect(result).toMatchObject({ text: 'Strategy based on the approved case' });
    expect(evaluationStore.reserve).toHaveBeenCalledTimes(1);
    const params = generateContent.mock.calls[0][0];
    expect(JSON.stringify(params)).toContain('Approved synthetic metrics');
    expect(params.config.tools).toBeUndefined();
    expect(params.config.maxOutputTokens).toBe(2048);
  });
  it('uses the provider-supported replacement when the legacy model rejects new projects', async () => {
    generateContent.mockImplementationOnce(async params => {
      if (params.model === 'gemini-2.5-flash') throw Object.assign(new Error('This model is no longer available to new users'), { status: 404 });
      return { candidates: [{ content: { parts: [{ text: 'Supported strategy' }] } }] };
    });
    await expect(runEvaluation('eval_test', { action: 'analyze', prompt: 'Strategy' })).resolves.toMatchObject({ text: 'Supported strategy' });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it('the supported analysis model has nonzero spend accounting', () => {
    expect(getModelPrice('gemini-3.6-flash')).toMatchObject({ inPerM: 0.75, outPerM: 3.75 });
  });
  it('exhausted budget makes no provider call', async () => {
    (evaluationStore.reserve as jest.Mock).mockRejectedValue(new Error('budget exhausted'));
    await expect(runEvaluation('eval_test', { action: 'analyze', prompt: 'Strategy' })).rejects.toThrow();
    expect(getGeminiClient).not.toHaveBeenCalled();
  });
  it('revocation during generation suppresses output and artifact persistence', async () => {
    generateContent.mockImplementationOnce(async () => {
      (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
      return { candidates: [{ content: { parts: [{ text: 'private output' }] } }] };
    });
    await expect(runEvaluation('eval_test', { action: 'analyze', prompt: 'Strategy' })).rejects.toThrow();
    expect(evaluationStore.saveArtifact).not.toHaveBeenCalled();
  });
  it.each([{}, { candidates: {} }, { candidates: [null] }, { candidates: [{ content: { parts: ['wrong-type'] } }] }])('rejects malformed provider data %p', async value => {
    generateContent.mockResolvedValueOnce(value);
    await expect(runEvaluation('eval_test', { action: 'analyze', prompt: 'Strategy' })).rejects.toThrow();
    expect(evaluationStore.saveArtifact).not.toHaveBeenCalled();
  });
  it('refuses a target-user override before generation', async () => {
    await expect(runEvaluation('eval_test', { action: 'analyze', prompt: 'Strategy', userId: 'staff' } as any)).rejects.toThrow();
    expect(getGeminiClient).not.toHaveBeenCalled();
  });
  it('stores a high-entropy generated creative within the private artifact size limit', async () => {
    const image = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
    generateContent.mockResolvedValueOnce({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }] } }] });
    await runEvaluation('eval_test', { action: 'generate_creative', prompt: 'Create an evaluation image' });
    expect((evaluationStore.saveArtifact as jest.Mock).mock.calls[0][1].length).toBeLessThanOrEqual(240000);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'eval_test', feature: 'evaluation', costUsdOverride: expect.any(Number) }));
    expect((recordUsage as jest.Mock).mock.calls[0][0].costUsdOverride).toBe(0.0672);
  });
});
