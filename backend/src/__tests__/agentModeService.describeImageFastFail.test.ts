/**
 * ENG-370 caveat resolution: describe_image must FAST-FAIL on a file that cannot
 * be decoded as an image (corrupt bytes, or a codec even sharp lacks) rather than
 * calling the vision model and letting the agent burn retries/workarounds. It also
 * must surface an actionable message telling the user which format to re-upload.
 *
 * sharp is intentionally NOT mocked here — real sharp decodes the bytes so the
 * undecodable path is exercised end-to-end.
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
// Keep REAL axios (transitive imports such as the Slack WebClient rely on
// axios.create/interceptors at load time) and override only .get for the download.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const get = (...a: any[]) => mockAxiosGet(...a);
  return {
    __esModule: true,
    ...actual,
    get,
    default: Object.assign(actual.default.create(), { get }),
  };
});

jest.mock('../utils/s3Utils', () => ({
  isS3Url: jest.fn().mockReturnValue(false),
  presignS3Url: jest.fn((u: string) => u),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

import { AgentModeService } from '../services/agentModeService';

describe('describeImage — fast-fail on an undecodable upload (ENG-370)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  it('returns a terminal, actionable error and never calls the vision model', async () => {
    // Bytes that are not any image format, labeled with a generic content-type so
    // the native-passthrough short-circuit does not apply.
    const garbage = Buffer.from('this is definitely not an image file at all', 'utf8');
    mockAxiosGet.mockResolvedValue({
      data: garbage,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'should not happen' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/logo.bin');

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/re-upload/i);
    expect(result.message).toMatch(/PNG or JPEG/i);
    // The whole point: we must NOT have spent a vision call on undecodable bytes.
    expect(callLLMSpy).not.toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it('still succeeds for a real PNG (no false fast-fail)', async () => {
    // Minimal valid 1x1 PNG.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const pngBytes = Buffer.from(pngBase64, 'base64');
    mockAxiosGet.mockResolvedValue({ data: pngBytes, headers: { 'content-type': 'application/octet-stream' } });
    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'a tiny logo' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/logo.bin');

    expect(result.success).toBe(true);
    expect(result.description).toBe('a tiny logo');
    expect(callLLMSpy).toHaveBeenCalled();
    // The mislabeled octet-stream was corrected to a real PNG data URI.
    const [, messages] = callLLMSpy.mock.calls[0];
    const imgBlock = (messages[0].content as any[]).find((c: any) => c.type === 'image_url');
    expect(imgBlock.image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});
