import { AgentModeService } from '../services/agentModeService';

// Behavioral proof for ENG-278: create_html_file must inline private-S3 images as
// base64 data URIs in DOCUMENT reports, while leaving emails and non-S3 images
// unchanged (behavior-preserving). All S3 access is mocked — no network.

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
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: { update: jest.fn() },
}));

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mock-hash'),
  })),
  randomUUID: jest.fn().mockReturnValue('mock-uuid-1234'),
  randomBytes: jest.fn((size: number) => Buffer.alloc(size, 0)),
  getRandomValues: jest.fn((arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = 0;
    return arr;
  }),
}));

jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn().mockReturnValue({ generateHTML: jest.fn() }),
}));

// Keep the real extractS3KeyFromUrl (pure URL parsing); mock the byte fetch and upload.
jest.mock('../utils/s3Utils', () => {
  const actual = jest.requireActual('../utils/s3Utils');
  return {
    ...actual,
    uploadFileToS3: jest.fn(),
    getS3ObjectAsBuffer: jest.fn(),
  };
});

const IMG_BYTES = Buffer.from('chart-png-bytes');
const IMG_B64 = IMG_BYTES.toString('base64');
const PRIVATE_IMG_URL =
  'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u1/files/1/chart.png';

describe('createHtmlFile — private-S3 image inlining (ENG-278)', () => {
  let service: AgentModeService;
  let mockGenerateHTML: jest.Mock;
  let mockUpload: jest.Mock;
  let mockGetBuffer: jest.Mock;
  const OLD_ENV = process.env;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, AWS_S3_BUCKET: 'agentweb-user-files' };

    (AgentModeService as any).toolsRegistered = false;
    service = new AgentModeService();
    await service.initialize();

    const { createLLMService } = require('../utils/llmService');
    mockGenerateHTML = createLLMService().generateHTML;

    const s3Utils = require('../utils/s3Utils');
    mockUpload = s3Utils.uploadFileToS3;
    mockGetBuffer = s3Utils.getS3ObjectAsBuffer;

    mockUpload.mockResolvedValue({
      success: true,
      url: 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/html_1_Report.html',
    });
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  const uploadedHtml = () => mockUpload.mock.calls[0][0] as string;

  it('inlines a private-S3 <img> as a base64 data URI before upload (document mode)', async () => {
    mockGenerateHTML.mockResolvedValue(
      `<!DOCTYPE html><html><body><h1>Report</h1><img src="${PRIVATE_IMG_URL}"></body></html>`,
    );
    mockGetBuffer.mockResolvedValue({ buffer: IMG_BYTES, contentType: 'image/png' });

    const result = await (service as any).createHtmlFile('Report', 'draft', '', 'u1', 's1');

    expect(result.success).toBe(true);
    expect(mockGetBuffer).toHaveBeenCalledWith('users/u1/files/1/chart.png', 'agentweb-user-files');
    const html = uploadedHtml();
    expect(html).toContain(`src="data:image/png;base64,${IMG_B64}"`);
    expect(html).not.toContain(PRIVATE_IMG_URL);
  });

  it('does NOT inline images in email mode — absolute URLs are preserved', async () => {
    mockGenerateHTML.mockResolvedValue(
      `<!DOCTYPE html><html><body><img src="${PRIVATE_IMG_URL}"></body></html>`,
    );
    mockGetBuffer.mockResolvedValue({ buffer: IMG_BYTES, contentType: 'image/png' });

    const result = await (service as any).createHtmlFile('News', 'draft', '', 'u1', 's1', 'email');

    expect(result.success).toBe(true);
    expect(mockGetBuffer).not.toHaveBeenCalled();
    expect(uploadedHtml()).toContain(PRIVATE_IMG_URL);
  });

  it('leaves non-S3 images untouched and uploads byte-identical HTML (behavior-preserving)', async () => {
    const html = `<!DOCTYPE html><html><body><img src="https://cdn.example.com/logo.png"></body></html>`;
    mockGenerateHTML.mockResolvedValue(html);

    const result = await (service as any).createHtmlFile('Report', 'draft', '', 'u1', 's1');

    expect(result.success).toBe(true);
    expect(mockGetBuffer).not.toHaveBeenCalled();
    expect(uploadedHtml()).toBe(html);
  });

  it('degrades gracefully: a fetch failure keeps the original URL and still creates the file', async () => {
    mockGenerateHTML.mockResolvedValue(
      `<!DOCTYPE html><html><body><img src="${PRIVATE_IMG_URL}"></body></html>`,
    );
    mockGetBuffer.mockRejectedValue(new Error('AccessDenied'));

    const result = await (service as any).createHtmlFile('Report', 'draft', '', 'u1', 's1');

    expect(result.success).toBe(true);
    expect(uploadedHtml()).toContain(PRIVATE_IMG_URL); // left as-is, no crash
  });
});
