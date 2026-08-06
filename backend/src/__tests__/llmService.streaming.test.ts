/**
 * ENG-873 — the Bedrock client is built with a 5-minute `requestTimeout`, which
 * @smithy implements as a socket-INACTIVITY timer that throws
 * "Stream timed out because of no activity for 300000 ms". A non-streaming
 * ConverseCommand puts no bytes on that socket until the whole response is
 * generated, so any render that takes longer than five minutes times out
 * deterministically — retrying reproduces it exactly. Two consecutive monthly
 * runs of a 40-competitor report died this way.
 *
 * Streaming switches to ConverseStreamCommand: chunks keep resetting the
 * inactivity timer, so a long generation no longer trips it. It must stay
 * opt-in, because it changes how every response on the instance is fetched.
 */
const mockInvoke = jest.fn();

jest.mock('@langchain/openai', () => ({
  AzureChatOpenAI: jest.fn().mockImplementation(() => ({ invoke: mockInvoke })),
}));
jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation(() => ({ invoke: mockInvoke })),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
}));

import { AzureChatOpenAI } from '@langchain/openai';
import { ChatBedrockConverse } from '@langchain/aws';
import { createLLMService } from '../utils/llmService';

const AzureMock = AzureChatOpenAI as unknown as jest.Mock;
const BedrockMock = ChatBedrockConverse as unknown as jest.Mock;

const CLAUDE = 'anthropic.claude-sonnet-4-6';

describe('LLMService streaming option', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
  });

  describe('stays off unless asked for', () => {
    it('does NOT stream on Bedrock when no options are passed', () => {
      createLLMService(CLAUDE, 0.8, 64000);
      expect(BedrockMock.mock.calls[0][0]).not.toHaveProperty('streaming');
    });

    it('does NOT stream on Azure when no options are passed', () => {
      createLLMService('gpt-4.1', 0.8, 4000);
      expect(AzureMock.mock.calls[0][0]).not.toHaveProperty('streaming');
    });

    it('does NOT stream when the option is explicitly false', () => {
      createLLMService(CLAUDE, 0.8, 64000, { streaming: false });
      expect(BedrockMock.mock.calls[0][0]).not.toHaveProperty('streaming');
    });

    it('does NOT stream when an options object is passed with no streaming key', () => {
      createLLMService(CLAUDE, 0.8, 64000, {});
      expect(BedrockMock.mock.calls[0][0]).not.toHaveProperty('streaming');
    });
  });

  describe('opts in without disturbing anything else', () => {
    it('streams on Bedrock when opted in', () => {
      createLLMService(CLAUDE, 0.8, 64000, { streaming: true });
      expect(BedrockMock.mock.calls[0][0]).toHaveProperty('streaming', true);
    });

    it('streams on Azure when opted in', () => {
      createLLMService('gpt-4.1', 0.8, 4000, { streaming: true });
      expect(AzureMock.mock.calls[0][0]).toHaveProperty('streaming', true);
    });

    it('keeps model, temperature and maxTokens intact alongside streaming', () => {
      createLLMService(CLAUDE, 0.8, 64000, { streaming: true });
      const args = BedrockMock.mock.calls[0][0];
      expect(args).toMatchObject({ temperature: 0.8, maxTokens: 64000, streaming: true });
      expect(args.model).toContain('claude-sonnet-4-6');
    });

    it('still omits temperature when null even with streaming on', () => {
      createLLMService(CLAUDE, null, 64000, { streaming: true });
      const args = BedrockMock.mock.calls[0][0];
      expect(args).not.toHaveProperty('temperature');
      expect(args).toHaveProperty('streaming', true);
    });
  });
});
