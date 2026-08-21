import {
  GatewayContractError,
  GatewayRequest,
  applyOpenRouterCacheBreakpoints,
  normalizeOpenRouterModelId,
} from '../utils/openRouterGatewayContract';
import * as gatewayContract from '../utils/openRouterGatewayContract';

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

describe('OpenRouter gateway migration resolver (ENG-1430)', () => {
  const resolveUpstreamModel = (logicalModelId: string) =>
    (gatewayContract as any).resolveOpenRouterUpstreamModelId(logicalModelId);

  it('keeps the already-working explicit OpenRouter namespace behavior', () => {
    expect(normalizeOpenRouterModelId('openrouter/openai/gpt-4o-mini')).toBe('openai/gpt-4o-mini');
  });

  it('maps an AgentWeb GPT logical id to OpenRouter provider/model form', () => {
    expect(resolveUpstreamModel('gpt-5.5')).toBe('openai/gpt-5.5');
  });

  it('maps an AgentWeb Gemini logical id to OpenRouter provider/model form', () => {
    expect(resolveUpstreamModel('gemini-3.7-flash')).toBe('google/gemini-3.7-flash');
  });

  it('maps every registered Bedrock Claude logical id explicitly', () => {
    expect(resolveUpstreamModel('anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(
      'anthropic/claude-sonnet-4.5',
    );
    expect(resolveUpstreamModel('anthropic.claude-opus-4-6-v1')).toBe('anthropic/claude-opus-4.6');
    expect(resolveUpstreamModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'anthropic/claude-haiku-4.5',
    );
  });

  it('fails closed when a migrated logical id has no verified OpenRouter mapping', () => {
    expect(() => resolveUpstreamModel('unknown-direct-model')).toThrow(GatewayContractError);
  });

  it('enables only an explicitly listed task class', () => {
    const enabled = (gatewayContract as any).isOpenRouterGatewayEnabledForTaskClass;
    expect(enabled('interactive_chat', 'interactive_chat,content_generation')).toBe(true);
    expect(enabled('scheduled_background', 'interactive_chat,content_generation')).toBe(false);
    expect(enabled(undefined, 'interactive_chat')).toBe(false);
  });

  it('uses explicit cache breakpoints without mutating the caller messages', () => {
    const messages = [
      { role: 'system', content: 'Stable instructions' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Latest question' },
    ];

    const cached = applyOpenRouterCacheBreakpoints(messages, true);

    expect(cached[0].content).toEqual([{ type: 'text', text: 'Stable instructions', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(cached[1].content).toEqual([{ type: 'text', text: 'Earlier answer', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    expect(messages).toEqual([
      { role: 'system', content: 'Stable instructions' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Latest question' },
    ]);
  });

  it('defaults a one-shot machine-paced breakpoint to five minutes', () => {
    expect(applyOpenRouterCacheBreakpoints([
      { role: 'user', content: 'Latest question' },
    ], false)[0].content).toEqual([{
      type: 'text', text: 'Latest question', cache_control: { type: 'ephemeral' },
    }]);
  });

  it('leaves message shapes unchanged when no text block can carry a breakpoint', () => {
    const messages = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1' }] },
      { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'https://example.com/result.png' } }] },
      { role: 'assistant', content: null },
    ];

    expect(applyOpenRouterCacheBreakpoints(messages, true)).toEqual(messages);
  });
});
