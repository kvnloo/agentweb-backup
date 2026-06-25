import {
  getOpenRouterBaseUrl,
  getOpenRouterHeaders,
  getOpenRouterModel,
  isOpenRouterConfigured,
} from '../../utils/openRouterConfig';

describe('openRouterConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_ENABLED;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.OPENROUTER_HTTP_REFERER;
    delete process.env.OPENROUTER_MODEL_GPT_5_CHAT_2;
    delete process.env.OPENROUTER_MODEL_MAP;
    delete process.env.OPENROUTER_TITLE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('only enables OpenRouter when an API key is configured and not disabled', () => {
    expect(isOpenRouterConfigured()).toBe(false);

    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(isOpenRouterConfigured()).toBe(true);

    process.env.OPENROUTER_ENABLED = 'false';
    expect(isOpenRouterConfigured()).toBe(false);
  });

  it('normalizes base URL and emits attribution headers without secrets', () => {
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.example/v1/';
    process.env.OPENROUTER_HTTP_REFERER = 'https://agentweb.pro';
    process.env.OPENROUTER_TITLE = 'AgentWeb Test';

    expect(getOpenRouterBaseUrl()).toBe('https://openrouter.example/v1');
    expect(getOpenRouterHeaders()).toEqual({
      'HTTP-Referer': 'https://agentweb.pro',
      'X-OpenRouter-Title': 'AgentWeb Test',
    });
  });

  it('maps legacy provider model names to OpenRouter slugs with override support', () => {
    expect(getOpenRouterModel('gpt-5-chat-2')).toBe('openai/gpt-5-chat-2');
    expect(getOpenRouterModel('anthropic.claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4-6');
    expect(getOpenRouterModel('gemini-3.5-flash')).toBe('google/gemini-3.5-flash');

    process.env.OPENROUTER_MODEL_GPT_5_CHAT_2 = 'openai/gpt-5.2';
    expect(getOpenRouterModel('gpt-5-chat-2')).toBe('openai/gpt-5.2');

    process.env.OPENROUTER_MODEL_MAP = JSON.stringify({ 'anthropic.claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6' });
    expect(getOpenRouterModel('anthropic.claude-sonnet-4-6')).toBe('anthropic/claude-sonnet-4.6');
  });

  it('adds :online for web-search requests without duplicating the suffix', () => {
    expect(getOpenRouterModel('gpt-5-chat-2', { webSearch: true })).toBe('openai/gpt-5-chat-2:online');

    process.env.OPENROUTER_MODEL_GPT_5_CHAT_2 = 'openai/gpt-5.2:online';
    expect(getOpenRouterModel('gpt-5-chat-2', { webSearch: true })).toBe('openai/gpt-5.2:online');
  });
});
