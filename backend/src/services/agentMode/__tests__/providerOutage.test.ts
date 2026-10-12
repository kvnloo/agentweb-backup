import { isLLMProviderOutage } from '../providerOutage';

describe('isLLMProviderOutage (ENG-2381)', () => {
  it('matches OpenRouter "503 Provider returned error" (wrapped)', () => {
    const e: any = new Error('wrapped');
    e.originalMessage = '503 Provider returned error';
    e.status = 503;
    expect(isLLMProviderOutage(e)).toBe(true);
  });

  it('matches an OpenAI SDK InternalServerError with headers', () => {
    class InternalServerError extends Error {}
    const e: any = new InternalServerError('500 internal');
    e.status = 500;
    e.headers = {};
    expect(isLLMProviderOutage(e)).toBe(true);
  });

  it('matches Bedrock ServiceUnavailableException', () => {
    const e: any = new Error('busy');
    e.name = 'ServiceUnavailableException';
    e.$metadata = { httpStatusCode: 503 };
    expect(isLLMProviderOutage(e)).toBe(true);
  });

  it('does NOT match an internal 503 (session/skill/settings work)', () => {
    const e: any = new Error('settings service unavailable');
    e.status = 503;
    expect(isLLMProviderOutage(e)).toBe(false);
  });

  it('does NOT match a DynamoDB InternalServerError', () => {
    const e: any = new Error('Internal server error');
    e.name = 'InternalServerError';
    e.$metadata = { httpStatusCode: 500 };
    expect(isLLMProviderOutage(e)).toBe(false);
  });
});
