const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function getOpenRouterApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key || null;
}

export function isOpenRouterConfigured(): boolean {
  const disabled = ['0', 'false', 'off'].includes((process.env.OPENROUTER_ENABLED || '').toLowerCase());
  return !disabled && !!getOpenRouterApiKey();
}

export function getOpenRouterBaseUrl(): string {
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).replace(/\/$/, '');
}

function envKeyForModel(model: string): string {
  return `OPENROUTER_MODEL_${model.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function readModelMap(): Record<string, string> {
  const raw = process.env.OPENROUTER_MODEL_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getOpenRouterModel(model: string, options: { webSearch?: boolean } = {}): string {
  const envOverride = process.env[envKeyForModel(model)];
  const mapped = envOverride || readModelMap()[model] || inferOpenRouterModel(model);
  if (!options.webSearch || mapped.includes(':online')) {
    return mapped;
  }
  return `${mapped}:online`;
}

function inferOpenRouterModel(model: string): string {
  if (model.includes('/')) return model;
  if (model.startsWith('gpt-')) return `openai/${model}`;
  if (model.startsWith('anthropic.')) return `anthropic/${model.slice('anthropic.'.length)}`;
  if (model.startsWith('claude-')) return `anthropic/${model}`;
  if (model.startsWith('gemini-')) return `google/${model}`;
  return model;
}

export function getOpenRouterHeaders(): Record<string, string> {
  return {
    ...(process.env.OPENROUTER_HTTP_REFERER
      ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER }
      : {}),
    'X-OpenRouter-Title': process.env.OPENROUTER_TITLE || 'AgentWeb',
  };
}
