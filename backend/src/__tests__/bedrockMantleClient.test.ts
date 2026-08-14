jest.mock('openai', () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
    embeddings: { create: jest.fn() },
  }));
  return { __esModule: true, default: MockOpenAI };
});

jest.mock('../services/usageRecorderService', () => ({
  recordUsage: jest.fn().mockResolvedValue(undefined),
  meterUserUsage: jest.fn(),
}));

import OpenAI from 'openai';
import { getBedrockMantleClient } from '../utils/llmClients';

const MockOpenAI = OpenAI as unknown as jest.Mock;
const meterCtx = { userId: 'user-1', feature: 'agent_task' };

describe('getBedrockMantleClient', () => {
  beforeEach(() => {
    MockOpenAI.mockClear();
    delete process.env.BEDROCK_MANTLE_API_KEY;
    delete process.env.BEDROCK_MANTLE_REGION;
  });

  it('rejects models outside the bounded Mantle catalog', () => {
    expect(() => getBedrockMantleClient(meterCtx, 'xai.grok-4.2')).toThrow(
      /unsupported Bedrock Mantle model/i,
    );
  });

  it('fails closed when the Mantle API key is missing', () => {
    expect(() => getBedrockMantleClient(meterCtx)).toThrow(
      /BEDROCK_MANTLE_API_KEY/i,
    );
  });

  it('uses the regional Mantle OpenAI-compatible endpoint and exact model id', () => {
    process.env.BEDROCK_MANTLE_API_KEY = 'mantle-test-key';
    process.env.BEDROCK_MANTLE_REGION = 'eu-west-1';

    const client = getBedrockMantleClient(meterCtx);

    expect(client).toBeDefined();
    expect(MockOpenAI).toHaveBeenCalledWith({
      apiKey: 'mantle-test-key',
      baseURL: 'https://bedrock-mantle.eu-west-1.api.aws/openai/v1',
    });
  });

  it('preserves OpenAI chat completion behavior while exposing the Grok model', async () => {
    process.env.BEDROCK_MANTLE_API_KEY = 'mantle-test-key';

    const client: any = getBedrockMantleClient(meterCtx, 'xai.grok-4.3', { metered: false });
    const response = { model: 'xai.grok-4.3', choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } };
    client.chat.completions.create.mockResolvedValue(response);

    await expect(client.chat.completions.create({ model: 'xai.grok-4.3', messages: [] })).resolves.toBe(response);
  });
});
