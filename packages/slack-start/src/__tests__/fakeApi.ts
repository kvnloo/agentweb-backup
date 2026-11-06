/**
 * In-memory stand-in for the backend Slack-start API (backend/src/routes/slackStart.ts).
 * Records every request so tests can assert the exact wire contract.
 */
import { TEST_CONFIG } from './testConfig';

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: RecordedCall) => { status: number; body: unknown } | undefined;

export function createFakeApi(base = 'https://api.test') {
  const calls: RecordedCall[] = [];
  const failures: Array<{ match: (c: RecordedCall) => boolean; status: number; body: unknown; times: number }> = [];
  let completeResponses: Array<{ status: number; body: unknown }> = [];
  const intake = { intakeId: 'intake-1', intakeToken: 'secret-token-abc', answers: {} as Record<string, unknown>, furthestStep: 1 };
  let override: Handler | undefined;
  let completeGate: Promise<void> | null = null;

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = { method: init.method ?? 'GET', path: url.pathname, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    const failure = failures.find((f) => f.times > 0 && f.match(call));
    if (failure) {
      failure.times -= 1;
      return respond(failure.status, failure.body);
    }
    const custom = override?.(call);
    if (custom) return respond(custom.status, custom.body);

    const p = '/api/onboarding/slack-start';
    if (call.method === 'GET' && call.path === `${p}/config`) return respond(200, TEST_CONFIG);
    if (call.method === 'POST' && call.path === p) return respond(202, { intakeId: intake.intakeId, intakeToken: intake.intakeToken, status: 'open' });
    const authed = headers.authorization === `Bearer ${intake.intakeToken}`;
    if (call.path.startsWith(`${p}/${intake.intakeId}`) && !authed) return respond(404, { code: 'not_found' });
    if (call.method === 'GET' && call.path === `${p}/${intake.intakeId}`) {
      return respond(200, { intakeId: intake.intakeId, status: 'open', answers: intake.answers, furthestStep: intake.furthestStep, email: 'sam@acme.co', website: 'https://acme.co' });
    }
    if (call.method === 'PATCH' && call.path === `${p}/${intake.intakeId}`) {
      Object.assign(intake.answers, call.body.answers);
      intake.furthestStep = Math.max(intake.furthestStep, call.body.step);
      return respond(200, { intakeId: intake.intakeId, answers: intake.answers, furthestStep: intake.furthestStep });
    }
    if (call.method === 'POST' && call.path === `${p}/${intake.intakeId}/complete`) {
      if (completeGate) await completeGate;
      const next = completeResponses.shift();
      return respond(next?.status ?? 200, next?.body ?? { intakeId: intake.intakeId, status: 'pending', slackConnectStatus: 'disabled' });
    }
    return respond(404, { code: 'not_found' });
  };

  return {
    base,
    calls,
    intake,
    fetch: fetchImpl as unknown as typeof fetch,
    failNext(match: (c: RecordedCall) => boolean, status: number, body: unknown = { code: 'internal_error' }, times = 1) {
      failures.push({ match, status, body, times });
    },
    setComplete(responses: Array<{ status: number; body: unknown }>) {
      completeResponses = responses;
    },
    /** Hold completion responses until the returned release function is called. */
    holdComplete(): () => void {
      let release!: () => void;
      completeGate = new Promise<void>((r) => (release = r));
      return () => {
        completeGate = null;
        release();
      };
    },
    setOverride(h: Handler) {
      override = h;
    },
    patches: () => calls.filter((c) => c.method === 'PATCH'),
  };
}
