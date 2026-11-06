import type { Answers, SlackStartConfig } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message || code);
  }
}

export interface StartResponse {
  intakeId: string;
  intakeToken: string;
  status: string;
}

export interface IntakeState {
  intakeId: string;
  status: string;
  answers: Answers;
  furthestStep: number;
  email: string;
  website: string;
}

export interface CompleteResponse {
  intakeId: string;
  status: 'pending' | 'invited' | 'processing';
  slackConnectStatus?: string;
}

/** Thin client for /api/onboarding/slack-start. Every non-2xx becomes an ApiError. */
export function createApiClient(apiBase: string, fetchImpl: typeof fetch) {
  const root = `${apiBase.replace(/\/+$/, '')}/api/onboarding/slack-start`;

  async function call<T>(method: string, path: string, opts: { body?: unknown; token?: string; idempotencyKey?: string } = {}) {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: 'omit',
      });
    } catch {
      throw new ApiError(0, 'network_error');
    }
    const text = await res.text().catch(() => '');
    let data: any = null;
    let parsed = !text;
    if (text) {
      try {
        data = JSON.parse(text);
        parsed = true;
      } catch {
        /* non-JSON body (proxy/error page) */
      }
    }
    if (!res.ok) throw new ApiError(res.status, data?.code ?? 'http_error', data?.message);
    // A 2xx we cannot read is not a success: the caller would act on data it never received.
    if (!parsed) throw new ApiError(res.status, 'invalid_response');
    return { status: res.status, data: data as T };
  }

  return {
    config: () => call<SlackStartConfig>('GET', '/config').then((r) => r.data),
    start: (body: { email: string; website: string; utm?: Record<string, string>; captchaToken?: string }, idempotencyKey: string) =>
      call<StartResponse>('POST', '', { body, idempotencyKey }).then((r) => r.data),
    read: (intakeId: string, token: string) => call<IntakeState>('GET', `/${encodeURIComponent(intakeId)}`, { token }).then((r) => r.data),
    answer: (intakeId: string, token: string, answers: Answers, step: number) =>
      call('PATCH', `/${encodeURIComponent(intakeId)}`, { token, body: { answers, step } }).then((r) => r.data),
    complete: (intakeId: string, token: string) =>
      call<CompleteResponse>('POST', `/${encodeURIComponent(intakeId)}/complete`, { token, body: {} }).then((r) => r.data),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
