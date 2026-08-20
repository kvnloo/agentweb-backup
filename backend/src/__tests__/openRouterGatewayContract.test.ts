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

  it('does not silently select a fallback when the logical id is unknown', () => {
    expect(() => normalizeOpenRouterModelId('not-a-model')).toThrow(
      'must be an OpenRouter upstream id',
    );
  });

  it('keeps task attribution, event id, and capability payload in the gateway request contract', () => {
    const request: GatewayRequest = {
      taskClass: 'interactive',
      logicalModelId: 'openrouter/openai/gpt-4o-mini',
      eventId: 'completion-1',
      stream: true,
      tools: [{ type: 'function' }],
      responseFormat: { type: 'json_schema' },
      input: [{ role: 'user', content: 'hello' }],
      timeoutMs: 30_000,
    };

    expect(request).toEqual(expect.objectContaining({
      taskClass: 'interactive',
      logicalModelId: 'openrouter/openai/gpt-4o-mini',
      eventId: 'completion-1',
    }));
  });
});
