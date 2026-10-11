jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn().mockResolvedValue({ orgId: 'image-org' }) }, orgDb: { getOrgById: jest.fn().mockResolvedValue({ modelRoles: {} }) } }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn().mockResolvedValue(null) } }));
jest.mock('../utils/secretsManager');
jest.mock('../utils/s3Utils');
jest.mock('openai');
jest.mock('axios');
jest.mock('@google/generative-ai');
jest.mock('@runwayml/sdk');
jest.mock('@google/genai');
jest.mock('../services/usageRecorderService', () => ({ recordUsage: jest.fn(), meterUserUsage: jest.fn() }));

// ENG-1535: generate_image provider failures map to a typed, user-actionable class
// instead of an unclassified error the gateway buckets as `repeated_failure`.
import axios from 'axios';
import { ImageService, classifyImageProviderError } from '../services/imageGeneration';
import * as secretsManager from '../utils/secretsManager';
import * as s3Utils from '../utils/s3Utils';

const axiosError = (status: number, message?: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: message ? { error: { message } } : {} },
  });

describe('classifyImageProviderError (ENG-1535)', () => {
  it.each([
    [axiosError(500), 'transient'],
    [axiosError(503), 'transient'],
    [new Error('Image generation with gpt-image-2 timed out after 480 seconds'), 'transient'],
    [axiosError(429, 'Requests exceeded call rate limit'), 'rate_limited'],
    [axiosError(429, 'You exceeded your current quota, please check your plan and billing details'), 'quota_exceeded'],
    [axiosError(400, 'Your request was rejected as a result of our safety system (content_policy_violation)'), 'policy'],
    [axiosError(401), 'config'],
    [new Error('Failed to fetch gpt-image-2 API key from Secrets Manager'), 'config'],
    [new Error('gpt-image-2 Azure image secret JSON is missing "endpoint"'), 'config'],
    [axiosError(400, 'Invalid size'), 'invalid_args'],
  ])('%s -> %s', (err, cls) => {
    expect(classifyImageProviderError(err)).toBe(cls);
  });
});

describe('ImageService.generateImage typed failures (ENG-1535)', () => {
  const svc = new ImageService();
  const base = { prompt: 'a cat', filename: 'cat.png', userId: 'u1', imageModel: 'gpt-image-2', size: '1024x1024' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    (s3Utils.uploadFileToS3 as jest.Mock).mockResolvedValue({ success: true, url: 'https://s3/img.png' });
    (secretsManager.getSecret as jest.Mock).mockResolvedValue(JSON.stringify({ apiKey: 'k', endpoint: 'https://x.openai.azure.com' }));
    (svc as any).retryWithBackoff = (fn: () => Promise<unknown>) => fn(); // no real backoff sleeps
  });

  it('missing provider configuration returns a typed config error before any provider call', async () => {
    (secretsManager.getSecret as jest.Mock).mockResolvedValue('');
    const r = await svc.generateImage({ ...base });
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('config');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('a 429 rate limit returns rate_limited with a wait-and-retry action', async () => {
    (axios.post as jest.Mock).mockRejectedValue(axiosError(429, 'Requests exceeded call rate limit'));
    const r = await svc.generateImage({ ...base });
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('rate_limited');
    expect(r.error).toMatch(/wait/i);
  });

  it('a content-policy rejection returns policy with a rephrase action', async () => {
    (axios.post as jest.Mock).mockRejectedValue(axiosError(400, 'rejected by safety system: content_policy_violation'));
    const r = await svc.generateImage({ ...base });
    expect(r.errorClass).toBe('policy');
    expect(r.error).toMatch(/rephrase/i);
  });

  it('a provider 5xx returns transient', async () => {
    (axios.post as jest.Mock).mockRejectedValue(axiosError(502));
    const r = await svc.generateImage({ ...base });
    expect(r.errorClass).toBe('transient');
  });

  it('an unsupported model is invalid_args', async () => {
    const r = await svc.generateImage({ ...base, imageModel: 'not-a-model' });
    expect(r.errorClass).toBe('invalid_args');
  });

  it('a provider failure returned as a result (not thrown) is still classified', async () => {
    jest.spyOn(svc as any, 'generateWithGoogleGemini').mockResolvedValue({ success: false, error: 'Gemini: 429 Too Many Requests' });
    const r = await svc.generateImage({ ...base, imageModel: 'gemini-2.5-flash-image' });
    expect(r.success).toBe(false);
    expect(r.errorClass).toBe('rate_limited');
  });

  it('happy path has no errorClass', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ status: 200, data: { data: [{ b64_json: Buffer.from('png').toString('base64') }] } });
    jest.spyOn(svc as any, 'removeC2PAMetadata').mockImplementation(async (b: any) => b);
    jest.spyOn(svc as any, 'runAdvisoryGates').mockResolvedValue(undefined);
    const r = await svc.generateImage({ ...base });
    expect(r.success).toBe(true);
    expect(r.errorClass).toBeUndefined();
  });
});
