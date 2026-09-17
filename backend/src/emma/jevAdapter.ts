/**
 * H-JEV: typed semantic decisions via TypeSafe System One or OpenJev-compatible HTTP.
 *
 * Wire format mirrors Hermes / oh-my-pi TypeSafeJudge: POST { state, model, questions }
 * → { model, answers, usage }.
 *
 * Fail-open: disabled backend, missing credentials, timeout, or transport errors never
 * throw into the agent loop — callers get { ok: false, skipped: true, reason, answers: {} }.
 */

export type JevBackend = 'off' | 'typesafe' | 'openjev';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JudgmentState = string | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: readonly [string, string, ...string[]];
}

export type JevQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number };

export interface JevDecideRequest {
  state: JudgmentState;
  questions: JevQuestions;
}

export type JevSkipReason =
  | 'disabled'
  | 'missing_credentials'
  | 'missing_base_url'
  | 'timeout'
  | 'http_error'
  | 'invalid_response'
  | 'validation_error';

export interface JevDecideSuccess {
  ok: true;
  skipped: false;
  backend: JevBackend;
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface JevDecideSkipped {
  ok: false;
  skipped: true;
  backend: JevBackend;
  reason: JevSkipReason;
  message: string;
  answers: Record<string, never>;
}

export type JevDecideResult = JevDecideSuccess | JevDecideSkipped;

export interface JevRuntimeConfig {
  backend: JevBackend;
  timeoutMs: number;
  model: string;
  typesafeBaseUrl: string;
  typesafeApiKey: string;
  openjevBaseUrl: string;
  openjevApiKey: string;
}

export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TYPESAFE_BASE_URL = 'https://api.typesafe.ai/v1';

export function parseJevBackend(raw: string | undefined): JevBackend {
  const value = (raw ?? 'off').trim().toLowerCase();
  if (value === 'typesafe' || value === 'openjev') return value;
  return 'off';
}

export function readJevRuntimeConfig(env: NodeJS.ProcessEnv = process.env): JevRuntimeConfig {
  const timeoutRaw = Number.parseInt(env.JEV_TIMEOUT_MS ?? '', 10);
  return {
    backend: parseJevBackend(env.JEV_BACKEND),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
    model: (env.JEV_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    typesafeBaseUrl: (env.TYPESAFE_BASE_URL ?? DEFAULT_TYPESAFE_BASE_URL).replace(/\/+$/, ''),
    typesafeApiKey: (env.TYPESAFE_API_KEY ?? '').trim(),
    openjevBaseUrl: (env.OPENJEV_BASE_URL ?? '').trim().replace(/\/+$/, ''),
    openjevApiKey: (env.OPENJEV_API_KEY ?? '').trim(),
  };
}

export function systemOneUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return root.endsWith('/v1') ? `${root}/systemone` : `${root}/v1/systemone`;
}

export function validateJevDecideRequest(request: JevDecideRequest): string | null {
  if (request.state === undefined || request.state === null) {
    return 'state is required';
  }
  if (!request.questions || typeof request.questions !== 'object' || Array.isArray(request.questions)) {
    return 'questions must be an object keyed by question id';
  }
  const entries = Object.entries(request.questions);
  if (entries.length === 0) {
    return 'questions must include at least one entry';
  }
  for (const [id, question] of entries) {
    if (!id.trim()) return 'question ids must be non-empty strings';
    if (!question || typeof question !== 'object') return `question "${id}" must be an object`;
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria ?? {});
      if (labels.length < 2) return `question "${id}" choice criteria needs at least two options`;
    } else if (question.type === 'noul') {
      if (!question.instructions?.trim()) return `question "${id}" noul instructions are required`;
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        return `question "${id}" score criteria needs at least two levels`;
      }
    } else {
      return `question "${id}" has unsupported type`;
    }
  }
  return null;
}

function skipped(
  backend: JevBackend,
  reason: JevSkipReason,
  message: string,
): JevDecideSkipped {
  return { ok: false, skipped: true, backend, reason, message, answers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAnswers(raw: unknown, questions: JevQuestions): Record<string, JevAnswer> | null {
  if (!isRecord(raw)) return null;
  const answersRaw = raw.answers;
  if (!isRecord(answersRaw)) return null;

  const parsed: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answersRaw[id];
    if (!isRecord(answer) || answer.type !== question.type) return null;
    parsed[id] = answer as JevAnswer;
  }
  return parsed;
}

export async function postSystemOne(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  state: JudgmentState;
  questions: JevQuestions;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): Promise<{ model: string; answers: Record<string, JevAnswer>; usage?: { input_tokens: number; output_tokens: number } }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (params.apiKey) {
      headers.Authorization = `Bearer ${params.apiKey}`;
    }

    const response = await fetchImpl(systemOneUrl(params.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        state: params.state,
        model: params.model,
        questions: params.questions,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    const body = (await response.json()) as unknown;
    if (!isRecord(body)) {
      throw new Error('response was not a JSON object');
    }

    const answers = parseAnswers(body, params.questions);
    if (!answers) {
      throw new Error('response missing typed answers for every question');
    }

    const usageRaw = body.usage;
    const usage =
      isRecord(usageRaw) &&
      typeof usageRaw.input_tokens === 'number' &&
      typeof usageRaw.output_tokens === 'number'
        ? { input_tokens: usageRaw.input_tokens, output_tokens: usageRaw.output_tokens }
        : undefined;

    return {
      model: typeof body.model === 'string' ? body.model : params.model,
      answers,
      usage,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RunJevDecideOptions {
  config?: JevRuntimeConfig;
  fetchImpl?: FetchLike;
}

export async function runJevDecide(
  request: JevDecideRequest,
  options: RunJevDecideOptions = {},
): Promise<JevDecideResult> {
  const config = options.config ?? readJevRuntimeConfig();
  const validationError = validateJevDecideRequest(request);
  if (validationError) {
    return skipped(config.backend, 'validation_error', validationError);
  }

  if (config.backend === 'off') {
    return skipped(config.backend, 'disabled', 'JEV_BACKEND is off; semantic decision skipped (fail-open).');
  }

  const isTypesafe = config.backend === 'typesafe';
  const baseUrl = isTypesafe ? config.typesafeBaseUrl : config.openjevBaseUrl;
  const apiKey = isTypesafe ? config.typesafeApiKey : config.openjevApiKey;

  if (isTypesafe && !apiKey) {
    return skipped(
      config.backend,
      'missing_credentials',
      'JEV_BACKEND=typesafe but TYPESAFE_API_KEY is unset; skipped (fail-open).',
    );
  }

  if (!isTypesafe && !baseUrl) {
    return skipped(
      config.backend,
      'missing_base_url',
      'JEV_BACKEND=openjev but OPENJEV_BASE_URL is unset; skipped (fail-open).',
    );
  }

  try {
    const result = await postSystemOne({
      baseUrl,
      apiKey,
      model: config.model,
      state: request.state,
      questions: request.questions,
      timeoutMs: config.timeoutMs,
      fetchImpl: options.fetchImpl,
    });

    return {
      ok: true,
      skipped: false,
      backend: config.backend,
      model: result.model,
      answers: result.answers,
      usage: result.usage,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return skipped(
        config.backend,
        'timeout',
        `JEV request timed out after ${config.timeoutMs}ms (fail-open).`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return skipped(config.backend, 'http_error', message);
  }
}
