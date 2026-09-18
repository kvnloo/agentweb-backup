/**
 * H-JEV: jev_decide adapter + tool wiring (issues #10, #11).
 *
 * JSON fixtures mirror Hermes/OpenJev System One wire shape. Network is mocked —
 * no live TypeSafe or OpenJev calls in CI.
 */

import * as fs from 'fs';
import * as path from 'path';

import '../emma/jevTools';
import { emmaToolRegistry } from '../emma/registry';
import {
  parseJevBackend,
  readJevRuntimeConfig,
  runJevDecide,
  systemOneUrl,
  type FetchLike,
  type JevDecideRequest,
  type JevRuntimeConfig,
} from '../emma/jevAdapter';

const FIXTURES = path.join(__dirname, 'fixtures', 'jev');

function loadFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

function mockFetch(responseBody: unknown, status = 200): FetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
  })) as unknown as FetchLike;
}

function typesafeConfig(overrides: Partial<JevRuntimeConfig> = {}): JevRuntimeConfig {
  return {
    backend: 'typesafe',
    timeoutMs: 2500,
    model: 'jev-latest',
    typesafeBaseUrl: 'https://api.typesafe.ai/v1',
    typesafeApiKey: 'test-key',
    openjevBaseUrl: '',
    openjevApiKey: '',
    ...overrides,
  };
}

describe('jevAdapter config + wire helpers', () => {
  it('defaults JEV_BACKEND to off', () => {
    expect(parseJevBackend(undefined)).toBe('off');
    expect(parseJevBackend('OFF')).toBe('off');
    expect(parseJevBackend('typesafe')).toBe('typesafe');
    expect(parseJevBackend('openjev')).toBe('openjev');
    expect(parseJevBackend('bogus')).toBe('off');
  });

  it('reads timeout and model from env', () => {
    const cfg = readJevRuntimeConfig({
      JEV_BACKEND: 'typesafe',
      JEV_TIMEOUT_MS: '1200',
      JEV_MODEL: 'jev-test',
      TYPESAFE_API_KEY: 'abc',
    } as NodeJS.ProcessEnv);
    expect(cfg.backend).toBe('typesafe');
    expect(cfg.timeoutMs).toBe(1200);
    expect(cfg.model).toBe('jev-test');
    expect(cfg.typesafeApiKey).toBe('abc');
  });

  it('builds System One URLs for v1 and non-v1 roots', () => {
    expect(systemOneUrl('https://api.typesafe.ai/v1')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(systemOneUrl('https://jev.local')).toBe('https://jev.local/v1/systemone');
  });
});

describe('runJevDecide fail-open paths', () => {
  it('skips when JEV_BACKEND=off', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const result = await runJevDecide(request, {
      config: typesafeConfig({ backend: 'off', typesafeApiKey: '' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
    expect(result.answers).toEqual({});
  });

  it('skips when typesafe backend lacks API key', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const result = await runJevDecide(request, {
      config: typesafeConfig({ typesafeApiKey: '' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_credentials');
  });

  it('skips when openjev backend lacks base URL', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const result = await runJevDecide(request, {
      config: typesafeConfig({ backend: 'openjev', openjevBaseUrl: '' }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('missing_base_url');
  });

  it('skips on HTTP error without throwing', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const fetchImpl = mockFetch({ error: 'nope' }, 503);

    const result = await runJevDecide(request, {
      config: typesafeConfig(),
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('http_error');
    expect(result.message).toMatch(/503/);
  });
  it('fail-opens on malformed provider answers (invalid choice label)', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const badResponse = {
      model: 'jev-latest',
      answers: {
        queue: {
          type: 'choice',
          choice: 'unknown_queue',
          probabilities: { account_access: 0.9, billing: 0.1 },
          confidence: 0.8,
        },
      },
    };
    const fetchImpl = mockFetch(badResponse);

    const result = await runJevDecide(request, {
      config: typesafeConfig(),
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_response');
    expect(result.answers).toEqual({});
  });

  it('fail-opens on malformed noul range', async () => {
    const request = loadFixture<JevDecideRequest>('gate-noul-request.json');
    const badResponse = {
      model: 'jev-latest',
      answers: { needs_ticket: { type: 'noul', noul: 5 } },
    };
    const fetchImpl = mockFetch(badResponse);

    const result = await runJevDecide(request, {
      config: typesafeConfig(),
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_response');
  });

});

describe('runJevDecide fixture-backed success paths', () => {
  it('returns choice answers from route fixture', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const response = loadFixture<{
      model: string;
      answers: { queue: { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } };
      usage: { input_tokens: number; output_tokens: number };
    }>('route-choice-response.json');
    const fetchImpl = mockFetch(response);

    const result = await runJevDecide(request, {
      config: typesafeConfig(),
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe('typesafe');
    expect(result.model).toBe('jev-latest');
    expect(result.answers.queue).toEqual(response.answers.queue);
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 8 });

    const fetchMock = fetchImpl as unknown as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      state: request.state,
      model: 'jev-latest',
      questions: request.questions,
    });
  });

  it('returns noul answers from gate fixture', async () => {
    const request = loadFixture<JevDecideRequest>('gate-noul-request.json');
    const response = loadFixture<Record<string, unknown>>('gate-noul-response.json');
    const fetchImpl = mockFetch(response);

    const result = await runJevDecide(request, {
      config: typesafeConfig(),
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.needs_ticket).toEqual({ type: 'noul', noul: 0.91 });
  });

  it('routes openjev backend to OPENJEV_BASE_URL', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const response = loadFixture<{
      model: string;
      answers: { queue: { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } };
      usage: { input_tokens: number; output_tokens: number };
    }>('route-choice-response.json');
    const fetchImpl = mockFetch(response);

    const result = await runJevDecide(request, {
      config: typesafeConfig({
        backend: 'openjev',
        openjevBaseUrl: 'http://127.0.0.1:8787',
        openjevApiKey: 'local',
      }),
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    const fetchMock = fetchImpl as unknown as jest.Mock;
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8787/v1/systemone');
  });
});

describe('jev_decide tool handler', () => {
  it('is registered in the Emma catalog', () => {
    const tool = emmaToolRegistry.getTool('jev_decide');
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
    expect(tool?.internal).toBe(true);
  });

  it('executes through the adapter and returns typed payload', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const response = loadFixture<{
      model: string;
      answers: { queue: { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number } };
      usage: { input_tokens: number; output_tokens: number };
    }>('route-choice-response.json');

    const fetchImpl = mockFetch(response);
    const originalFetch = global.fetch;
    global.fetch = fetchImpl as unknown as typeof fetch;

    const prevBackend = process.env.JEV_BACKEND;
    const prevKey = process.env.TYPESAFE_API_KEY;
    process.env.JEV_BACKEND = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'test-key';

    try {
      const result = await emmaToolRegistry.execute('jev_decide', request);
      expect(result.type).toBe('jev_decide');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.answers.queue.choice).toBe('account_access');
    } finally {
      global.fetch = originalFetch;
      if (prevBackend === undefined) delete process.env.JEV_BACKEND;
      else process.env.JEV_BACKEND = prevBackend;
      if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prevKey;
    }
  });

  it('fail-opens through the tool when backend is off', async () => {
    const request = loadFixture<JevDecideRequest>('route-choice-request.json');
    const prevBackend = process.env.JEV_BACKEND;
    process.env.JEV_BACKEND = 'off';

    try {
      const result = await emmaToolRegistry.execute('jev_decide', request);
      expect(result.type).toBe('jev_decide');
      expect(result.ok).toBe(false);
      expect(result.skipped).toBe(true);
    } finally {
      if (prevBackend === undefined) delete process.env.JEV_BACKEND;
      else process.env.JEV_BACKEND = prevBackend;
    }
  });
});
