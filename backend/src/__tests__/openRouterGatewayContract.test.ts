import {
  GatewayContractError,
  GatewayRequest,
  normalizeOpenRouterModelId,
} from '../utils/openRouterGatewayContract';

describe('OpenRouter gateway contract — model identity boundary (ENG-1414)', () => {
  it.each([
    ['openrouter/openai/gpt-4o-mini', 'openai/gpt-4o-mini'],
    ['openrouter/z-ai/glm-5.2', 'z-ai/glm-5.2'],
    ['openai/gpt-4o-mini', 'openai/gpt-4o-mini'],
    ['gpt-5.4', 'gpt-5.4'],
  ])('normalizes %s to the valid upstream id %s', (logicalModelId, upstreamModelId) => {
    expect(normalizeOpenRouterModelId(logicalModelId)).toBe(upstreamModelId);
  });

  it.each([
    '',
    'openrouter/',
    'openrouter/openai/',
    'openrouter//gpt-4o-mini',
    'openrouter/openai/gpt-4o-mini/extra',
  ])('rejects malformed model id %j with a typed gateway error', (modelId) => {
    expect(() => normalizeOpenRouterModelId(modelId)).toThrow(GatewayContractError);
  });

  it('does not change non-OpenRouter logical IDs before their migration slice', () => {
    expect(normalizeOpenRouterModelId('not-a-model')).toBe('not-a-model');
  });

  it('keeps task attribution, event id, and capability payload in the gateway request contract', () => {
    const request: GatewayRequest = {
      taskClass: 'interactive_chat',
      logicalModelId: 'openrouter/openai/gpt-4o-mini',
      eventId: 'completion-1',
      stream: true,
      tools: [{ type: 'function' }],
      responseFormat: { type: 'json_schema' },
      input: [{ role: 'user', content: 'hello' }],
      timeoutMs: 30_000,
    };

    expect(request).toEqual(expect.objectContaining({
      taskClass: 'interactive_chat',
      logicalModelId: 'openrouter/openai/gpt-4o-mini',
      eventId: 'completion-1',
    }));
  });
});
