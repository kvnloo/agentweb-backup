/**
 * ENG-834: describe_image's vision fallback switches PROVIDERS (Gemini ->
 * Bedrock Claude), so it is not a retry of the failed call.
 *
 * isRetryableMediaToolError answers "would this same call succeed if repeated",
 * and it correctly says no for a credential/permission failure — hammering the
 * same model with a bad key is pointless. But that is exactly the case where a
 * DIFFERENT provider would succeed, because it authenticates entirely
 * separately. So a Gemini 403 hard-failed describe_image even though Bedrock
 * was sitting right there, healthy, and would have answered.
 *
 * That is the same shape as the bug this ticket exists to fix: a
 * provider-specific rejection surfacing to the user as a broken tool. And it
 * fails wide — a bad Gemini key breaks EVERY describe_image call at once, and
 * the user is told to re-upload their image.
 *
 * The shared classifier is deliberately NOT changed: generate_image relies on
 * its current narrowness (ENG-510), so this widening is local to describe_image.
 */

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));

const mockAxiosGet = jest.fn();
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const get = (...a: any[]) => mockAxiosGet(...a);
  return { __esModule: true, ...actual, get, default: Object.assign(actual.default.create(), { get }) };
});

jest.mock('../utils/s3Utils', () => ({
  isS3Url: jest.fn().mockReturnValue(true),
  presignS3Url: jest.fn((u: string) => `${u}?presigned=1`),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

import { AgentModeService } from '../services/agentModeService';

const S3_URL =
  'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/x/files/1/y/cover.png';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/** Real @google/genai error shape: class ApiError, own keys ["name","status"]. */
function apiError(status: number, body: string): Error {
  const e = new Error(body);
  e.name = 'ApiError';
  (e as any).status = status;
  return e;
}

describe('describeImage — provider-scoped failures fail over to the other vision provider (ENG-834)', () => {
  let service: AgentModeService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockAxiosGet.mockResolvedValue({ status: 200, data: PNG, headers: { 'content-type': 'image/png' } });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => warn.mockRestore());

  /** Primary (gemini) throws `err`; the Bedrock fallback is healthy. */
  function primaryFails(err: Error) {
    return jest.spyOn(service, 'callLLM').mockImplementation(async (model: string) => {
      if (model.startsWith('gemini-')) throw err;
      return { choices: [{ message: { content: 'described by fallback' } }] } as any;
    });
  }

  it.each([
    ['403 PERMISSION_DENIED', apiError(403, '{"error":{"code":403,"message":"Permission denied.","status":"PERMISSION_DENIED"}}')],
    ['401 UNAUTHENTICATED', apiError(401, '{"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}')],
  ])('fails over to the other provider on %s instead of hard-failing', async (_label, err) => {
    const spy = primaryFails(err);

    const result = await service.describeImage('gemini-3.5-flash', S3_URL);

    expect(result.success).toBe(true);
    expect(result.description).toBe('described by fallback');
    expect(result.fallbackUsed).toBe(true);
    expect(result.model).toBe('anthropic.claude-opus-4-8');
    // The signal survives the recovery — a broken key must still be diagnosable.
    expect(result.primaryError).toContain(_label.startsWith('403') ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('still fails over on a transient 503 (pre-existing behaviour preserved)', async () => {
    primaryFails(apiError(503, '{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}'));

    const result = await service.describeImage('gemini-3.5-flash', S3_URL);

    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe(true);
  });

  it('does NOT fail over on a payload rejection — a second provider would not help', async () => {
    // The image is already normalised and downscaled before this call, so a 400
    // INVALID_ARGUMENT is about the request, not the provider. Burning a second
    // vision call on it would just double the latency and cost.
    const spy = primaryFails(
      apiError(400, '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}')
    );

    const result = await service.describeImage('gemini-3.5-flash', S3_URL);

    expect(result.success).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not blame the user\'s file when both providers are unreachable', async () => {
    jest.spyOn(service, 'callLLM').mockRejectedValue(
      apiError(403, '{"error":{"code":403,"message":"Permission denied.","status":"PERMISSION_DENIED"}}')
    );

    const result = await service.describeImage('gemini-3.5-flash', S3_URL);

    expect(result.success).toBe(false);
    // Our credentials are broken; telling them to re-export a PNG sends them
    // round a loop that cannot succeed.
    expect(result.message).not.toMatch(/re-upload/i);
    expect(result.message).toMatch(/vision model/i);
  });
});
