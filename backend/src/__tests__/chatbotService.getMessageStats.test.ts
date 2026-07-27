import { chatbotDb } from '../services/chatbotService';
import AWS from 'aws-sdk';

// Mock AWS DynamoDB and S3
jest.mock('aws-sdk', () => {
  const queryMock = jest.fn();
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: jest.fn(() => ({ promise: queryMock })),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
    config: { update: jest.fn() },
    __queryMock: queryMock,
  };
});

// Mock other imports that chatbotService depends on
jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(),
}));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

const queryMock = (AWS as any).__queryMock;

describe('chatbotDb.getMessageStats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return empty stats for a session with no messages', async () => {
    queryMock.mockResolvedValue({ Items: [] });

    const stats = await chatbotDb.getMessageStats('session-empty');

    expect(stats.totalMessages).toBe(0);
    expect(stats.messagesWithToolCalls).toBe(0);
    expect(stats.successfulToolCalls).toBe(0);
    expect(stats.failedToolCalls).toBe(0);
    expect(stats.messagesByRole).toEqual({ user: 0, assistant: 0, system: 0, tool: 0 });
  });

  it('should count messages by role', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'user' } },
        { message: { role: 'assistant' } },
        { message: { role: 'user' } },
        { message: { role: 'system' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.totalMessages).toBe(4);
    expect(stats.messagesByRole.user).toBe(2);
    expect(stats.messagesByRole.assistant).toBe(1);
    expect(stats.messagesByRole.system).toBe(1);
    expect(stats.messagesByRole.tool).toBe(0);
  });

  it('should count successful tool calls from tool role messages', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'user', content: 'Generate an image' } },
        { message: { role: 'assistant', content: 'I will generate that.' } },
        { message: { role: 'tool', content: '{"success":true,"imageUrl":"https://example.com/img.png"}' } },
        { message: { role: 'tool', content: '{"success":true,"message":"Task created"}' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.messagesWithToolCalls).toBe(2);
    expect(stats.successfulToolCalls).toBe(2);
    expect(stats.failedToolCalls).toBe(0);
  });

  it('should count failed tool calls from Tool Error prefix', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'tool', content: '⚠️ Tool Error: generate_image\nReason: API rate limit exceeded\nNext: Adjust the plan.' } },
        { message: { role: 'tool', content: '⚠️ Tool Error: search_web\nReason: Network timeout\nNext: Retry.' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.messagesWithToolCalls).toBe(2);
    expect(stats.successfulToolCalls).toBe(0);
    expect(stats.failedToolCalls).toBe(2);
  });

  it('should count failed tool calls from "success":false in content', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'tool', content: '{"success":false,"message":"campaign_ids is required"}' } },
        { message: { role: 'tool', content: '{"success": false, "message": "Invalid JSON in replacement_json"}' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.messagesWithToolCalls).toBe(2);
    expect(stats.successfulToolCalls).toBe(0);
    expect(stats.failedToolCalls).toBe(2);
  });

  it('should correctly mix successful and failed tool calls', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'user', content: 'Do several things' } },
        { message: { role: 'tool', content: '{"success":true,"taskId":"t1"}' } },
        { message: { role: 'tool', content: '⚠️ Tool Error: search_web\nReason: timeout\nNext: Retry.' } },
        { message: { role: 'tool', content: '{"success":false,"error":"Invalid input"}' } },
        { message: { role: 'tool', content: 'Here is the analysis result for your query...' } },
        { message: { role: 'assistant', content: 'Done.' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.totalMessages).toBe(6);
    expect(stats.messagesWithToolCalls).toBe(4);
    expect(stats.successfulToolCalls).toBe(2); // success:true + plain text (no failure indicator)
    expect(stats.failedToolCalls).toBe(2); // Tool Error prefix + success:false
    expect(stats.messagesByRole.tool).toBe(4);
    expect(stats.messagesByRole.user).toBe(1);
    expect(stats.messagesByRole.assistant).toBe(1);
  });

  it('should count messages with attachments', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'user', metadata: { attachments: [{ url: 'file.jpg', filename: 'file.jpg', size: 100, mimetype: 'image/jpeg', uploadedAt: '2026-01-01' }] } } },
        { message: { role: 'user', metadata: { attachments: [] } } },
        { message: { role: 'user' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.messagesWithAttachments).toBe(1);
  });

  it('should aggregate token usage', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: { role: 'assistant', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } } },
        { message: { role: 'assistant', usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 } } },
        { message: { role: 'user' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.totalTokens).toBe(430);
    expect(stats.totalPromptTokens).toBe(300);
    expect(stats.totalCompletionTokens).toBe(130);
    expect(stats.messagesWithTokenData).toBe(2);
  });

  it('should handle items with missing message field', async () => {
    queryMock.mockResolvedValue({
      Items: [
        { message: null },
        {},
        { message: { role: 'user', content: 'Hello' } },
      ],
    });

    const stats = await chatbotDb.getMessageStats('session-1');

    expect(stats.totalMessages).toBe(3);
    expect(stats.messagesByRole.user).toBe(1);
  });
});
