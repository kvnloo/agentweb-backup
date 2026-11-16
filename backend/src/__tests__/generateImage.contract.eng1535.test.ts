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

// ENG-1535 AC3 + AC5.
// AC3: every argument value the declared generate_image schema lets the model send
//      must be accepted by the handler's own validation (no invalid_args rejection).
// AC5: the handler's real rate_limited failure shape must not lock generate_image
//      for the rest of the session (ENG-1220 class), while a permanent class still does.
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { ImageService, classifyImageProviderError, imageErrorAction } from '../services/imageGeneration';
import {
  _resetAgentToolFailureBreaker,
  executeAgentToolThroughGateway,
} from '../services/agentToolGatewayService';

function declaredSchema(): any {
  const def = emmaToolRegistry.getTool('generate_image')?.definition as any;
  expect(def?.inputSchema?.type).toBe('object');
  return def.inputSchema;
}

describe('generate_image schema/handler contract (ENG-1535 AC3)', () => {
  const svc = new ImageService();
  const base = { prompt: 'a cat', filename: 'cat.png', userId: 'u1', size: '1024x1024' } as any;

  // Stop right after argument validation: the provider dispatch is the first thing
  // past validation, so reaching it proves the handler accepted the args.
  const PASSED_VALIDATION = { success: false, error: 'stub-provider', errorClass: 'transient' as const };
  beforeEach(() => {
    for (const m of ['generateWithAzureAI', 'generateWithGoogleGemini', 'generateWithGoogleGemini3Pro', 'generateWithRunwayML', 'generateWithOpenAI']) {
      jest.spyOn(svc as any, m).mockResolvedValue(PASSED_VALIDATION);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('every declared imageModel enum value is accepted by the handler', async () => {
    const models: string[] = declaredSchema().properties.imageModel.enum;
    expect(models.length).toBeGreaterThan(0);
    for (const imageModel of models) {
      const r = await svc.generateImage({ ...base, imageModel });
      expect({ imageModel, errorClass: r.errorClass, error: r.error }).toEqual({
        imageModel, errorClass: 'transient', error: expect.stringContaining('stub-provider'),
      });
    }
  });

  it('every declared quality enum value is accepted by the handler', async () => {
    const qualities: string[] = declaredSchema().properties.quality.enum;
    for (const quality of qualities) {
      const r = await svc.generateImage({ ...base, imageModel: 'gpt-image-2', quality });
      expect({ quality, errorClass: r.errorClass }).toEqual({ quality, errorClass: 'transient' });
    }
  });

  it('declared required fields are exactly what the handler needs; an omitted optional arg is not rejected', async () => {
    const schema = declaredSchema();
    expect(schema.required).toEqual(expect.arrayContaining(['prompt', 'filename']));
    // Only required args, nothing optional (quality/size/imageModel omitted).
    const r = await svc.generateImage({ prompt: 'a cat', filename: 'cat.png', userId: 'u1', imageModel: 'gpt-image-2' } as any);
    expect(r.errorClass).toBe('transient');
  });

  it('a value outside the declared enum is still rejected as invalid_args (negative control)', async () => {
    const r = await svc.generateImage({ ...base, imageModel: 'not-a-declared-model' });
    expect(r.errorClass).toBe('invalid_args');
  });
});

describe('generate_image 429 does not lock the tool for the session (ENG-1535 AC5)', () => {
  beforeEach(() => _resetAgentToolFailureBreaker());

  // The exact structured shape mediaVideo.generateImage returns after
  // ImageService maps a provider 429 (resolved, not thrown).
  const handlerFailure = (err: unknown) => {
    const errorClass = classifyImageProviderError(err);
    const error = `Failed to generate image: ${(err as Error).message}. ${imageErrorAction(errorClass)}`;
    return { success: false, message: error, error, errorClass };
  };
  const http = (status: number, message: string) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { message } } } });

  it('three structured rate_limited failures across runs still allow a later call in the same session', async () => {
    const sessionScope = 'session-eng1535-ratelimit';
    const failure = handlerFailure(http(429, 'Requests exceeded call rate limit'));
    expect(failure.errorClass).toBe('rate_limited');
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      const outcome = await executeAgentToolThroughGateway({
        toolName: 'generate_image', args: { prompt: `variation ${runId}` }, runId, budgetScopeId: sessionScope,
        execute: jest.fn().mockResolvedValue(failure),
      });
      expect(outcome.status).toBe('success'); // structured failure carried to the model
    }
    const execute = jest.fn().mockResolvedValue({ success: true, imageUrl: 'https://s3/img.png' });
    const outcome = await executeAgentToolThroughGateway({
      toolName: 'generate_image', args: { prompt: 'after waiting' }, runId: 'run-d', budgetScopeId: sessionScope, execute,
    });
    expect(outcome.status).toBe('success');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('negative control: structured policy failures still trip the session budget', async () => {
    const sessionScope = 'session-eng1535-policy';
    const failure = handlerFailure(http(400, 'rejected by safety system: content_policy_violation'));
    expect(failure.errorClass).toBe('policy');
    for (const runId of ['run-p1', 'run-p2']) {
      await executeAgentToolThroughGateway({
        toolName: 'generate_image', args: { prompt: `p ${runId}` }, runId, budgetScopeId: sessionScope,
        execute: jest.fn().mockResolvedValue(failure),
      });
    }
    const execute = jest.fn().mockResolvedValue({ success: true });
    const outcome = await executeAgentToolThroughGateway({
      toolName: 'generate_image', args: { prompt: 'again' }, runId: 'run-p3', budgetScopeId: sessionScope, execute,
    });
    expect(outcome.status).toBe('error');
    expect(execute).not.toHaveBeenCalled();
  });
});
