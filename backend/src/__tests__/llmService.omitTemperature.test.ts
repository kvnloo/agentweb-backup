/**
 * Some Azure deployments (e.g. gpt-5-chat-2) reject ANY non-default temperature
 * with a 400 `unsupported_value`. LLMService sent `temperature` unconditionally,
 * so every plain-path caller passing 0.0/0.1 failed — including the V3 critic,
 * whose error was swallowed into a console.warn. The critic therefore never ran,
 * leaving ENG-122 without its correctness / wrong-entity backstop.
 *
 * `temperature: null` means "omit the parameter and let the deployment default",
 * so a caller can opt out without changing behaviour for anyone else.
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

describe('LLMService temperature handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
  });

  it('passes a numeric temperature through to Azure (unchanged for existing callers)', () => {
    createLLMService('gpt-4.1', 0.0);
    expect(AzureMock).toHaveBeenCalledTimes(1);
    const args = AzureMock.mock.calls[0][0];
    expect(args).toHaveProperty('temperature', 0.0);
  });

  it('OMITS temperature entirely when null (deployments that only accept the default)', () => {
    createLLMService('gpt-5-chat-2', null);
    expect(AzureMock).toHaveBeenCalledTimes(1);
    const args = AzureMock.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
  });

  it('still targets the right deployment when temperature is omitted', () => {
    createLLMService('gpt-5-chat-2', null);
    const args = AzureMock.mock.calls[0][0];
    expect(args.azureOpenAIApiDeploymentName).toBe('gpt-5-chat-2');
  });

  it('omits temperature on the Bedrock branch too when null', () => {
    createLLMService('anthropic.claude-sonnet-4-5-20250929-v1:0', null);
    expect(BedrockMock).toHaveBeenCalledTimes(1);
    const args = BedrockMock.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
  });

  it('defaults to 0.8 when temperature is not supplied at all', () => {
    createLLMService('gpt-4.1');
    const args = AzureMock.mock.calls[0][0];
    expect(args).toHaveProperty('temperature', 0.8);
  });
});
