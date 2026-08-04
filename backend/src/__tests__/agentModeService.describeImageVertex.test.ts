/**
 * Tests that describeImage downloads + base64-encodes the image for Vertex Claude
 * (claude-*) models, not just Bedrock (anthropic.*). This covers the branch added
 * to fix the Vertex Opus 4.8 image_url 400.
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

jest.mock('../utils/s3Utils', () => ({
  isS3Url: jest.fn().mockReturnValue(false),
  presignS3Url: jest.fn((u: string) => u),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

import { AgentModeService } from '../services/agentModeService';

describe('describeImage — Vertex Claude (claude-*) image download', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  it('downloads + base64-encodes the image for a claude-* model and sends a data URI', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    mockAxiosGet.mockResolvedValue({ status: 200, data: pngBytes, headers: { 'content-type': 'image/png' } });

    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'a chart' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', 'https://example.com/chart.png');

    expect(result.success).toBe(true);
    expect(result.description).toBe('a chart');
    // The image was actually downloaded (claude-* now triggers the download branch)
    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://example.com/chart.png',
      expect.objectContaining({ responseType: 'arraybuffer' })
    );
    // The content block carries a base64 data URI, not the bare URL
    const [, messages] = callLLMSpy.mock.calls[0];
    const imgBlock = (messages[0].content as any[]).find((c: any) => c.type === 'image_url');
    expect(imgBlock.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(imgBlock.image_url.url).not.toBe('https://example.com/chart.png');
  });

  it('passes a data: URI through unchanged (no re-download)', async () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const callLLMSpy = jest
      .spyOn(service, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content: 'ok' } }] } as any);

    const result = await service.describeImage('anthropic.claude-opus-4-8', dataUri);

    expect(result.success).toBe(true);
    expect(mockAxiosGet).not.toHaveBeenCalled();
    const [, messages] = callLLMSpy.mock.calls[0];
    const imgBlock = (messages[0].content as any[]).find((c: any) => c.type === 'image_url');
    expect(imgBlock.image_url.url).toBe(dataUri);
  });

  it('returns a friendly error when no image URL is provided', async () => {
    const result = await service.describeImage('anthropic.claude-opus-4-8', '');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No image URL/i);
  });
});
