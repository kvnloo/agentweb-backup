// Mock all external dependencies before importing
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({
    query: jest.fn(() => ({ promise: jest.fn() })),
    get: jest.fn(() => ({ promise: jest.fn() })),
    put: jest.fn(() => ({ promise: jest.fn() })),
    update: jest.fn(() => ({ promise: jest.fn() })),
    batchWrite: jest.fn(() => ({ promise: jest.fn() })),
    delete: jest.fn(() => ({ promise: jest.fn() })),
    scan: jest.fn(() => ({ promise: jest.fn() })),
  })) },
  S3: jest.fn(() => ({ upload: jest.fn().mockReturnThis(), promise: jest.fn(), getObject: jest.fn(() => ({ promise: jest.fn() })), getSignedUrlPromise: jest.fn() })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) })) })),
  config: { update: jest.fn() },
}));
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({ EngineServiceClient: jest.fn(), SearchServiceClient: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn() }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {
  getAllTaskExecutionsByUserId: jest.fn(),
  getTasksByUserId: jest.fn(),
  getTaskExecutionsByTaskId: jest.fn(),
} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));
jest.mock('../services/chatbotService', () => ({
  ChatbotDB: jest.fn(() => ({})),
  chatbotDb: {},
}));
jest.mock('../services/agentModeService', () => ({
  AgentModeService: jest.fn(),
}));
jest.mock('../config', () => ({ MAX_MESSAGE_SIZE_PER_SESSION: 1000 }));

import { scanMessagesForAssets } from '../utils/scanMessagesForAssets';
import { ChatSession } from '../services/chatbotService';

const makeSession = (overrides?: Partial<ChatSession>): ChatSession => ({
  sessionId: 'sess-1',
  userId: 'user-1',
  messages: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  ...overrides,
});

describe('scanMessagesForAssets', () => {
  it('should extract images from generate_image tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: 'https://s3.amazonaws.com/img1.png', filename: 'logo.png' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({
      url: 'https://s3.amazonaws.com/img1.png',
      filename: 'logo.png',
      generatedAt: '2026-01-01T12:00:00Z',
    });
    expect(result.videos).toHaveLength(0);
    expect(result.htmlReports).toHaveLength(0);
  });

  it('should extract videos from generate_video tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_video',
            result: { success: true, videoUrl: 'https://s3.amazonaws.com/vid1.mp4', filename: 'demo.mp4' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.videos).toHaveLength(1);
    expect(result.videos[0].url).toBe('https://s3.amazonaws.com/vid1.mp4');
  });

  it('should extract HTML reports from tool call result fields', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_report',
            result: { s3_url: 'https://s3.amazonaws.com/report.html', filename: 'report.html' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.htmlReports).toHaveLength(1);
    expect(result.htmlReports[0].url).toBe('https://s3.amazonaws.com/report.html');
  });

  it('should extract HTML URLs from message content via regex', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Here is your report: https://bucket.s3.amazonaws.com/reports/report1.html',
        timestamp: '2026-01-01T12:00:00Z',
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.htmlReports).toHaveLength(1);
    expect(result.htmlReports[0].url).toBe('https://bucket.s3.amazonaws.com/reports/report1.html');
  });

  it('should deduplicate URLs across messages', () => {
    const url = 'https://s3.amazonaws.com/img1.png';
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: url, filename: 'img.png' },
          }],
        },
      },
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T13:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: url, filename: 'img.png' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(1);
  });

  it('should extract all asset types in a single pass', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Report: https://bucket.s3.amazonaws.com/output.html',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [
            {
              name: 'generate_image',
              result: { success: true, imageUrl: 'https://s3.amazonaws.com/img.png', filename: 'img.png' },
            },
            {
              name: 'generate_video',
              result: { success: true, videoUrl: 'https://s3.amazonaws.com/vid.mp4', filename: 'vid.mp4' },
            },
          ],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(1);
    expect(result.videos).toHaveLength(1);
    expect(result.htmlReports).toHaveLength(1);
  });

  it('should skip failed tool calls (no success flag)', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: false, error: 'Generation failed' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(0);
  });

  it('should inherit timestamp from last assistant message for tool results', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T14:00:00Z',
        metadata: { toolCalls: [] },
      },
      {
        role: 'tool',
        content: '',
        // No timestamp — should inherit from previous assistant message
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: 'https://s3.amazonaws.com/img.png', filename: 'img.png' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].generatedAt).toBe('2026-01-01T14:00:00Z');
  });

  it('should fall back to session timestamps when no message timestamp', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: 'https://s3.amazonaws.com/img.png', filename: 'img.png' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession({
      updatedAt: '2026-02-01T00:00:00Z',
    }));

    expect(result.images[0].generatedAt).toBe('2026-02-01T00:00:00Z');
  });

  it('should use metadata timestamp before session timestamp', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        metadata: {
          timestamp: '2026-01-03T10:00:00Z',
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: 'https://s3.amazonaws.com/img.png', filename: 'img.png' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images[0].generatedAt).toBe('2026-01-03T10:00:00Z');
  });

  it('should fall back to createdAt when updatedAt is missing', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        metadata: {
          toolCalls: [{
            name: 'generate_video',
            result: { success: true, videoUrl: 'https://s3.amazonaws.com/generated.mp4' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession({
      updatedAt: undefined,
      createdAt: '2026-03-01T00:00:00Z',
    }));

    expect(result.videos[0]).toEqual({
      url: 'https://s3.amazonaws.com/generated.mp4',
      filename: 'generated-video.mp4',
      generatedAt: '2026-03-01T00:00:00Z',
    });
  });

  it('should use default filename when not provided', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'generate_image',
            result: { success: true, imageUrl: 'https://s3.amazonaws.com/img.png' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images[0].filename).toBe('generated-image.png');
  });

  it('should handle upload_image tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'upload_image',
            result: { success: true, imageUrl: 'https://s3.amazonaws.com/uploaded.jpg', filename: 'photo.jpg' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(1);
    expect(result.images[0].filename).toBe('photo.jpg');
  });

  it('should handle upload_video tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [{
            name: 'upload_video',
            result: { success: true, videoUrl: 'https://s3.amazonaws.com/uploaded.mp4', filename: 'clip.mp4' },
          }],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.videos).toHaveLength(1);
  });

  it('should collect HTML reports from every supported result field', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [
            {
              name: 'write_file',
              result: { file_url: 'https://s3.amazonaws.com/report-from-file.htm', file_name: 'file-report.htm' },
            },
            {
              name: 'publish_report',
              result: { htmlUrl: 'https://s3.amazonaws.com/report-from-html-url.HTML', versioned_filename: 'versioned.HTML' },
            },
            {
              name: 'publish_blog',
              result: { blog_html_url: 'https://s3.amazonaws.com/blog-report.html' },
            },
          ],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.htmlReports).toEqual([
      {
        url: 'https://s3.amazonaws.com/report-from-file.htm',
        filename: 'file-report.htm',
        generatedAt: '2026-01-01T12:00:00Z',
      },
      {
        url: 'https://s3.amazonaws.com/report-from-html-url.HTML',
        filename: 'versioned.HTML',
        generatedAt: '2026-01-01T12:00:00Z',
      },
      {
        url: 'https://s3.amazonaws.com/blog-report.html',
        filename: 'blog-report.html',
        generatedAt: '2026-01-01T12:00:00Z',
      },
    ]);
  });

  it('should skip non-HTML result URLs and duplicate content URLs', () => {
    const htmlUrl = 'https://s3.amazonaws.com/report.html';
    const messages = [
      {
        role: 'assistant',
        content: `Duplicate report: ${htmlUrl}`,
        timestamp: '2026-01-01T12:00:00Z',
        metadata: {
          toolCalls: [
            {
              name: 'write_file',
              result: { s3_url: htmlUrl, filename: 'report.html' },
            },
            {
              name: 'write_file',
              result: { file_url: 'https://s3.amazonaws.com/raw.json', filename: 'raw.json' },
            },
          ],
        },
      },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.htmlReports).toHaveLength(1);
    expect(result.htmlReports[0].url).toBe(htmlUrl);
  });

  it('should return empty arrays for messages with no assets', () => {
    const messages = [
      { role: 'user', content: 'Hello', timestamp: '2026-01-01T12:00:00Z' },
      { role: 'assistant', content: 'Hi there!', timestamp: '2026-01-01T12:01:00Z' },
    ];

    const result = scanMessagesForAssets(messages, makeSession());

    expect(result.images).toHaveLength(0);
    expect(result.videos).toHaveLength(0);
    expect(result.htmlReports).toHaveLength(0);
  });
});
