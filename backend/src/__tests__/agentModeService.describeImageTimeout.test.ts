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

  // ENG-294 refix: a malformed override (typo like "90s", a negative, or junk) must
  // NOT silently disable the bound — that would recreate the exact unbounded-call bug
  // this fix exists to prevent. Parsing fails closed to the default positive bound;
  // only a clean, explicit 0 disables. Assert on resolveDescribeImageTimeoutMs directly
  // because the default bound (90s) is too long to exercise end-to-end in a unit test.
  describe('timeout env-var parsing fails closed', () => {
    const DEFAULT_MS = 90000;

    it.each([
      ['non-numeric junk', 'abc'],
      ['trailing-unit typo', '90s'],
      ['negative value', '-5'],
      ['negative default typo', '-90000'],
      ['whitespace-only', '   '],
      ['float junk', '1.2.3'],
    ])('falls back to the default bound for %s (%p) — call stays bounded', (_label, value) => {
      process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = value;
      const resolved = AgentModeService.resolveDescribeImageTimeoutMs();
      // A positive result means callVisionLLMWithTimeout takes the bounded Promise.race
      // branch rather than the disabled passthrough — the hung-call bug cannot recur.
      expect(resolved).toBe(DEFAULT_MS);
      expect(resolved).toBeGreaterThan(0);
    });

    it('uses the default when the override is unset', () => {
      delete process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS;
      expect(AgentModeService.resolveDescribeImageTimeoutMs()).toBe(DEFAULT_MS);
    });

    it('honors a clean positive integer override', () => {
      process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = '1234';
      expect(AgentModeService.resolveDescribeImageTimeoutMs()).toBe(1234);
    });

    it('treats a clean explicit 0 as the disable escape hatch', () => {
      process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = '0';
      expect(AgentModeService.resolveDescribeImageTimeoutMs()).toBe(0);
    });
  });

  it('a malformed override still bounds a hung primary and falls back', async () => {
    // Regression guard for the fail-open bug: with a garbage override the primary
    // must still time out (default bound) and route to the fallback model. We shrink
    // the default via a spy so the test stays fast while proving the bounded branch runs.
    process.env.AGENT_MODE_DESCRIBE_IMAGE_TIMEOUT_MS = 'not-a-number';
    jest.spyOn(AgentModeService, 'resolveDescribeImageTimeoutMs').mockReturnValue(50);

    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockImplementationOnce(neverResolves)
      .mockResolvedValueOnce({ choices: [{ message: { content: 'fallback description' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/chart.png');

    expect(result.success).toBe(true);
    expect(result.fallbackUsed).toBe(true);
    expect(result.primaryError).toMatch(/timed out/i);
    expect(callLLMSpy).toHaveBeenCalledTimes(2);
  }, 10000);
});
