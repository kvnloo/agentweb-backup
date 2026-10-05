/**
 * ENG-2060 — verifier-owned work-plan lifecycle probe for ENG-2057.
 *
 * Drives list -> launch -> poll -> answer -> read-back through the MCP tool surface
 * against a dedicated, non-customer fixture. It is transport-agnostic: the caller
 * supplies `callTool` (the live OAuth MCP client in post-merge verification, or the
 * in-process registry in tests), so the same evidence shape comes out of both.
 *
 * Safety is fail closed: the probe refuses to launch anything that is not the named
 * verifier fixture owned by the verifier account, and never answers a request whose
 * fields differ from the fixture's deterministic contract. Polling is bounded, so a
 * misbehaving plan cannot loop on provider spend.
 */

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Title prefix that marks a plan as verifier-owned. Customer plans never carry it. */
export const VERIFIER_FIXTURE_PREFIX = '[verifier-fixture]';

export interface FixtureContract {
  /** Exact plan title, must start with VERIFIER_FIXTURE_PREFIX. */
  planTitle: string;
  /** Field ids the fixture's structured input request must contain, and the values to submit. */
  answers: Record<string, string>;
}

export const DEFAULT_FIXTURE: FixtureContract = {
  planTitle: `${VERIFIER_FIXTURE_PREFIX} MCP work-plan lifecycle`,
  answers: { verifier_token: 'eng-2060-deterministic' },
};

export interface ProbeOptions {
  sessionId: string;
  /** Account the session must belong to; the probe refuses sessions owned by anyone else. */
  verifierUserId: string;
  fixture?: FixtureContract;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export type ProbeStep = 'list' | 'launch' | 'poll_input' | 'answer' | 'readback';

export interface ProbeEvidence {
  ok: boolean;
  failedStep?: ProbeStep;
  reason?: string;
  planId?: string;
  requestId?: string;
  polls: number;
  steps: Array<{ step: ProbeStep; ok: boolean; detail?: string }>;
}

export class ProbeRefusal extends Error {}

function decode(result: unknown): any {
  // MCP tool results arrive as { content: [{ type: 'text', text: '<json>' }] }.
  const text = (result as any)?.content?.[0]?.text;
  if (typeof text === 'string') {
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

export async function runWorkPlanLifecycleProbe(callTool: CallTool, opts: ProbeOptions): Promise<ProbeEvidence> {
  const fixture = opts.fixture ?? DEFAULT_FIXTURE;
  const maxPolls = opts.maxPolls ?? 20;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? 3000;
  const evidence: ProbeEvidence = { ok: false, polls: 0, steps: [] };
  const fail = (step: ProbeStep, reason: string): ProbeEvidence => {
    evidence.steps.push({ step, ok: false, detail: reason });
    return { ...evidence, ok: false, failedStep: step, reason };
  };

  if (!fixture.planTitle.startsWith(VERIFIER_FIXTURE_PREFIX)) {
    throw new ProbeRefusal(`fixture title must start with ${VERIFIER_FIXTURE_PREFIX}`);
  }
  if (!opts.verifierUserId) throw new ProbeRefusal('verifierUserId is required');

  // 1. list — the fixture must exist, be unique, and be owned by the verifier.
  const listed = decode(await callTool('list_predefined_work_plans', {}));
  const plans: any[] = Array.isArray(listed) ? listed : Array.isArray(listed?.plans) ? listed.plans : [];
  const matches = plans.filter((p) => p?.title === fixture.planTitle);
  if (matches.length !== 1) return fail('list', `expected exactly one fixture plan, found ${matches.length}`);
  const plan = matches[0];
  const owner = plan.userId ?? plan.ownerId ?? plan.createdBy;
  if (owner !== undefined && owner !== opts.verifierUserId) {
    return fail('list', 'fixture plan is not owned by the verifier account');
  }
  evidence.planId = plan.id;
  evidence.steps.push({ step: 'list', ok: true });

  // Session ownership check before any mutation.
  const before = decode(await callTool('emma_get_session', { session_id: opts.sessionId }));
  const sessionOwner = before?.userId ?? before?.session?.userId;
  if (sessionOwner !== opts.verifierUserId) {
    return fail('launch', 'session is not owned by the verifier account; refusing to mutate');
  }

  // 2. launch
  const launched = decode(await callTool('emma_launch_work_plan', { session_id: opts.sessionId, plan_id: plan.id }));
  if (launched?.success !== true) return fail('launch', `launch refused: ${launched?.message ?? 'unknown'}`);
  evidence.steps.push({ step: 'launch', ok: true });

  // 3. poll until the deterministic input request is awaiting (bounded).
  let pending: any = null;
  while (evidence.polls < maxPolls) {
    evidence.polls += 1;
    const s = decode(await callTool('emma_get_session', { session_id: opts.sessionId }));
    if (s?.pendingWorkPlanInput?.status === 'awaiting') { pending = s.pendingWorkPlanInput; break; }
    await sleep(interval);
  }
  if (!pending) return fail('poll_input', `no awaiting pendingWorkPlanInput after ${maxPolls} polls`);
  const fieldIds = (pending.fields ?? []).map((f: any) => f?.id).sort();
  const expected = Object.keys(fixture.answers).sort();
  if (JSON.stringify(fieldIds) !== JSON.stringify(expected)) {
    return fail('poll_input', `input fields ${JSON.stringify(fieldIds)} do not match fixture ${JSON.stringify(expected)}`);
  }
  evidence.requestId = pending.requestId;
  evidence.steps.push({ step: 'poll_input', ok: true });

  // 4. answer
  const answered = decode(await callTool('emma_answer_work_plan_input', {
    session_id: opts.sessionId, request_id: pending.requestId, values: fixture.answers,
  }));
  if (answered?.success === false) return fail('answer', `answer refused: ${answered?.message ?? 'unknown'}`);
  evidence.steps.push({ step: 'answer', ok: true });

  // 5. read back — the request must no longer be awaiting.
  const after = decode(await callTool('emma_get_session', { session_id: opts.sessionId }));
  if (after?.pendingWorkPlanInput?.status === 'awaiting' && after.pendingWorkPlanInput.requestId === pending.requestId) {
    return fail('readback', 'input request still awaiting after answer');
  }
  evidence.steps.push({ step: 'readback', ok: true });
  return { ...evidence, ok: true };
}
