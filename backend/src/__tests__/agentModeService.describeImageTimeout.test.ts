/**
 * ENG-294: describe_image must bound its vision LLM call so a slow/hung vision
 * model fails fast and falls back, instead of consuming the whole agent-mode
 * generation wall-clock budget (default 10 min). A production CSV→CRM sync that
 * OCR'd contact screenshots via describe_image timed out repeatedly (6 failed
 * describe_image calls) because a single un-bounded call could stall for the
 * client's 5-minute per-request timeout — and with callLLM's internal retries
 * plus the fallback model, one image could burn 10+ minutes.
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
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockAxiosGet(...a) },
  get: (...a: any[]) => mockAxiosGet(...a),
}));

// slackService instantiates a Slack WebClient at import time (which needs the real
// axios); mock it so the module graph loads under the mocked axios above.
jest.mock('../services/slackService', () => ({}));

jest.mock('../utils/s3Utils', () => ({
  isS3Url: jest.fn().mockReturnValue(false),
  presignS3Url: jest.fn((u: string) => u),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

import { AgentModeService } from '../services/agentModeService';

describe('describeImage — vision call timeout (ENG-294)', () => {
  let service: AgentModeService;
  const OLD_ENV = process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS;

  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  // A promise that never resolves — simulates a hung/overloaded vision model.
  const neverResolves = () => new Promise<any>(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
    // Short timeout keeps the test fast while exercising the real timeout path.
    process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = '50';
    mockAxiosGet.mockResolvedValue({ data: pngBytes, headers: { 'content-type': 'image/png' } });
    service = new AgentModeService();
  });

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS;
    } else {
      process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = OLD_ENV;
    }
  });

  it('falls back to the fallback vision model when the primary hangs past the timeout', async () => {
    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      // primary (opus) hangs forever
      .mockImplementationOnce(neverResolves)
      // fallback answers
      .mockResolvedValueOnce({ choices: [{ message: { content: 'fallback description' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/chart.png');

    expect(result.success).toBe(true);
    expect(result.description).toBe('fallback description');
    expect(result.fallbackUsed).toBe(true);
    expect(result.primaryError).toMatch(/timed out/i);
    // Both the primary and the fallback model were attempted.
    expect(callLLMSpy).toHaveBeenCalledTimes(2);
  }, 10000);

  it('returns a friendly failure when BOTH the primary and fallback hang', async () => {
    jest.spyOn(service, 'callLLM').mockImplementation(neverResolves);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/chart.png');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/primary and fallback/i);
  }, 10000);

  it('does not time out a fast primary vision call (no fallback used)', async () => {
    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'a chart' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/chart.png');

    expect(result.success).toBe(true);
    expect(result.description).toBe('a chart');
    expect(result.fallbackUsed).toBeUndefined();
    expect(callLLMSpy).toHaveBeenCalledTimes(1);
  });

  it('setting the timeout to 0 disables the bound (a resolving call still succeeds)', async () => {
    process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = '0';
    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'ok' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/chart.png');

    expect(result.success).toBe(true);
    expect(callLLMSpy).toHaveBeenCalledTimes(1);
  });
});
