import { generateChatResponse } from '../services/chatbotService';

/**
 * ENG-9 — the chatbot's provider dispatch is substring-based and pre-dates the
 * OpenRouter registry slugs. A slug reaching it would silently mis-route:
 * "anthropic/claude-*" → Bedrock (rejects the id), "google/gemini-*" → direct
 * Gemini (404), "openai/gpt-5.5" → Azure with the "/" embedded in the deployment
 * URL path. The chatbot must fail fast with a clear error instead.
 */

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({ Location: 'mock-url', Key: 'mock-key' }),
    }),
  })),
}));

describe('chatbotService — OpenRouter slugs are rejected fast and clear (ENG-9)', () => {
  it.each([
    'openai/gpt-5.5',
    'anthropic/claude-opus-4.8',
    'google/gemini-3.5-flash',
  ])('rejects %s with a clear error before any provider dispatch', async (slug) => {
    await expect(
      generateChatResponse('session-x', 'hello', { model: slug })
    ).rejects.toThrow(/OpenRouter/i);
  });
});
