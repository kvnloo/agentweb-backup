import {
  assertOpenRouterToolsSupported,
  gatewayAcceptsTemperature,
  openRouterIgnoredProviders,
  selectOpenRouterSamplingParams,
} from '../openRouterRequestParams';

const BASE = { supportsTemperature: true };

describe('selectOpenRouterSamplingParams (ENG-1831)', () => {
  it('defaults tool_choice to auto when caller tools are present', () => {
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-opus-5', capabilities: BASE, hasCallerTools: true,
    })).toEqual({ tool_choice: 'auto' });
  });

  it('passes an explicit tool_choice through', () => {
    const toolChoice = { type: 'function', function: { name: 'noop' } };
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-opus-5', capabilities: BASE, hasCallerTools: true, toolChoice,
    }).tool_choice).toBe(toolChoice);
  });

  it('omits tool_choice without caller tools, even when one is requested', () => {
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-opus-5', capabilities: BASE, hasCallerTools: false, toolChoice: 'required',
    })).toEqual({});
  });

  it('omits tool_choice for a model flagged supportsToolChoice: false (ENG-199)', () => {
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-fable-5.1',
      capabilities: { ...BASE, supportsToolChoice: false },
      hasCallerTools: true,
      toolChoice: 'required',
      temperature: 0.3,
    })).toEqual({ temperature: 0.3 });
  });

  it('omits tool_choice when any fallback cannot receive it', () => {
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-opus-5',
      capabilities: BASE,
      fallbacks: [{ upstreamModel: 'anthropic/claude-fable-5.1', capabilities: { ...BASE, supportsToolChoice: false } }],
      hasCallerTools: true,
    })).toEqual({});
  });

  it('sends temperature only when supplied and supported', () => {
    const call = (temperature: number | null | undefined, capabilities = BASE) => selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-opus-5', capabilities, hasCallerTools: false, temperature,
    });
    expect(call(0)).toEqual({ temperature: 0 });
    expect(call(null)).toEqual({});
    expect(call(undefined)).toEqual({});
    expect(call(0.5, { supportsTemperature: false })).toEqual({});
  });

  it('never sends temperature to GPT-5.x, whatever the registry flag says', () => {
    expect(gatewayAcceptsTemperature('openai/gpt-5.5')).toBe(false);
    expect(gatewayAcceptsTemperature('openai/gpt-4o-mini')).toBe(true);
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'openai/gpt-5.5', capabilities: BASE, hasCallerTools: false, temperature: 0.5,
    })).toEqual({});
  });

  it('omits temperature when a fallback cannot receive it', () => {
    expect(selectOpenRouterSamplingParams({
      upstreamModel: 'anthropic/claude-opus-5',
      capabilities: BASE,
      fallbacks: [{ upstreamModel: 'openai/gpt-5.5', capabilities: BASE }],
      hasCallerTools: false,
      temperature: 0.5,
    })).toEqual({});
  });
});

describe('assertOpenRouterToolsSupported (ENG-1831)', () => {
  const sonar = { modelId: 'openrouter/perplexity/sonar-deep-research', capabilities: { ...BASE, supportsTools: false } };
  const opus = { modelId: 'anthropic.claude-opus-5', capabilities: BASE };

  it('allows a tool-less request to a tool-less model', () => {
    expect(() => assertOpenRouterToolsSupported([sonar], 0)).not.toThrow();
  });

  it('allows tools when every chain member accepts them', () => {
    expect(() => assertOpenRouterToolsSupported([opus], 3)).not.toThrow();
  });

  it('throws, naming the model, when a chain member cannot receive tools', () => {
    expect(() => assertOpenRouterToolsSupported([opus, sonar], 1))
      .toThrow(/'openrouter\/perplexity\/sonar-deep-research' cannot receive tools/);
  });
});

describe('openRouterIgnoredProviders', () => {
  it('excludes no provider, so Gemini can use the Vertex BYOK slot (ENG-2704)', () => {
    expect(openRouterIgnoredProviders('google/gemini-3.5-flash')).toEqual([]);
    expect(openRouterIgnoredProviders('anthropic/claude-opus-5')).toEqual([]);
  });
});

import { OPENROUTER_PROVIDER_PREFERENCES } from '../openRouterRequestParams';

describe('shared BYOK policy', () => {
  it('prefers all configured cloud families without restricting gateway fallbacks', () => {
    expect(OPENROUTER_PROVIDER_PREFERENCES.allow_fallbacks).toBe(true);
    expect(OPENROUTER_PROVIDER_PREFERENCES.order).toEqual([
      'amazon-bedrock', 'azure', 'google-vertex', 'anthropic', 'openai',
    ]);
    expect(OPENROUTER_PROVIDER_PREFERENCES).not.toHaveProperty('only');
    expect(Object.isFrozen(OPENROUTER_PROVIDER_PREFERENCES.order)).toBe(true);
  });
});
