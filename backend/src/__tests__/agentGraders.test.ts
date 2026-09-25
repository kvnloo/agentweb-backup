/**
 * ENG-2137 / ENG-2128 surface A: agent graders. Fixtures are synthetic; no customer data.
 */
import {
  aggregateByModelAndTaskType,
  classifyTaskType,
  efficiencyMetrics,
  gradeGroundedness,
  gradeSession,
  gradeTaskSuccess,
  gradeToolCorrectness,
  type AgentLoopEvent,
  type EfficiencyInput,
  type LedgerCall,
  type SessionForGrading,
  type ToolCorrectnessResult,
} from '../loops/eval/agentGraders';
import { wilsonInterval } from '../loops/eval/agreement';
import { getGrader, mayGate } from '../loops/eval/evalRegistry';
import { evaluateReplayCase, type FailureReplayCase } from '../loops/eval/failureReplaySuite';
import { computeRunVerdict } from '../loops/instances/agent-mode/runRecorder';

let seq = 0;
function call(toolName: string, args: Record<string, unknown> = {}, extra: Partial<LedgerCall> = {}): LedgerCall {
  seq++;
  return { id: `call_${seq}`, toolName, args, status: 'success', ...extra };
}

function ev(eventType: string, dimensions: AgentLoopEvent['dimensions'] = {}, runId = 'run-1'): AgentLoopEvent {
  seq++;
  return { eventType, runId, ts: `2026-09-25T00:00:${String(seq % 60).padStart(2, '0')}.000Z`, dimensions };
}

function session(overrides: Partial<SessionForGrading> = {}): SessionForGrading {
  return {
    sessionId: 's-1',
    ledger: [],
    events: [],
    endsWithRunFailurePlaceholder: false,
    userTurns: 1,
    ...overrides,
  };
}

const steps = (...statuses: string[]) => statuses.map((status, i) => ({ stepCount: i + 1, status }));
const WORK = [call('you_search_web', { query: 'x' })];

describe('gradeTaskSuccess (ENG-1710 relaxed label)', () => {
  it('excludes a run that did not finish, even with a complete plan', () => {
    const r = gradeTaskSuccess(session({ endsWithRunFailurePlaceholder: true, workPlan: { steps: steps('completed') }, ledger: WORK }));
    expect(r).toMatchObject({ verdict: 'excluded', reason: 'run_did_not_finish' });
  });

  it('excludes sessions without a work plan', () => {
    expect(gradeTaskSuccess(session({ ledger: WORK })).reason).toBe('no_work_plan');
    expect(gradeTaskSuccess(session({ workPlan: { steps: [] }, ledger: WORK })).reason).toBe('no_work_plan');
  });

  it('excludes zero-tool-call sessions', () => {
    const r = gradeTaskSuccess(session({ workPlan: { steps: steps('completed', 'pending') } }));
    expect(r).toMatchObject({ verdict: 'excluded', reason: 'zero_tool_calls' });
  });

  it('counts tool calls from loop events when the ledger is empty', () => {
    const r = gradeTaskSuccess(session({
      workPlan: { steps: steps('completed') },
      events: [ev('agent_tool_invoked', { toolName: 'you_search_web' }), ev('agent_tool_succeeded', { toolName: 'you_search_web' })],
    }));
    expect(r.verdict).toBe('success');
  });

  it('excludes a plan that was created but never worked on', () => {
    const r = gradeTaskSuccess(session({
      workPlan: { steps: steps('pending', 'pending') },
      ledger: [call('create_work_plan'), call('set_work_plan_status')],
    }));
    expect(r).toMatchObject({ verdict: 'excluded', reason: 'plan_never_engaged' });
  });

  it('fails a plan that was worked on but never completed a step', () => {
    const r = gradeTaskSuccess(session({ workPlan: { steps: steps('pending', 'pending') }, ledger: [call('create_work_plan'), ...WORK] }));
    expect(r).toMatchObject({ verdict: 'failure', reason: 'no_step_completed' });
    expect(gradeTaskSuccess(session({ workPlan: { steps: steps('skipped', 'skipped') }, ledger: WORK })).reason).toBe('no_step_completed');
  });

  it('succeeds when every step is completed or skipped', () => {
    const r = gradeTaskSuccess(session({ workPlan: { steps: steps('completed', 'skipped', 'completed') }, ledger: WORK }));
    expect(r).toEqual({ verdict: 'success', reason: 'plan_complete', steps: { total: 3, completed: 2, skipped: 1, pending: 0 } });
  });

  it('allows exactly one pending step, and only as the last step', () => {
    expect(gradeTaskSuccess(session({ workPlan: { steps: steps('completed', 'completed', 'pending') }, ledger: WORK })))
      .toMatchObject({ verdict: 'success', reason: 'plan_complete_one_trailing_pending' });
    expect(gradeTaskSuccess(session({ workPlan: { steps: steps('completed', 'pending', 'completed') }, ledger: WORK })))
      .toMatchObject({ verdict: 'failure', reason: 'pending_steps', detail: '1/3 steps pending' });
    expect(gradeTaskSuccess(session({ workPlan: { steps: steps('completed', 'pending', 'pending') }, ledger: WORK })))
      .toMatchObject({ verdict: 'failure', reason: 'pending_steps', detail: '2/3 steps pending' });
  });

  it('fails a completed step whose required function never succeeded (verified, not self-reported)', () => {
    const plan = { steps: [{ stepCount: 1, status: 'completed', requiredFunctionCalls: ['send_email'] }] };
    expect(gradeTaskSuccess(session({ workPlan: plan, ledger: [...WORK, call('send_email', {}, { status: 'error' })] })))
      .toMatchObject({ verdict: 'failure', reason: 'completed_step_without_tool_evidence', detail: 'step 1: send_email' });
    // an encoded failure ({ success: false }) is not evidence either
    expect(gradeTaskSuccess(session({ workPlan: plan, ledger: [call('send_email', {}, { result: { success: false, error: 'bounced' } })] })).verdict)
      .toBe('failure');
    expect(gradeTaskSuccess(session({ workPlan: plan, ledger: [call('send_email')] })).verdict).toBe('success');
    // evidence may come from the loop events alone
    expect(gradeTaskSuccess(session({ workPlan: plan, ledger: WORK, events: [ev('agent_tool_succeeded', { toolName: 'send_email' })] })).verdict)
      .toBe('success');
  });

  it('does not require evidence for a pending or skipped step', () => {
    const plan = { steps: [{ stepCount: 1, status: 'completed' }, { stepCount: 2, status: 'skipped', requiredFunctionCalls: ['send_email'] }] };
    expect(gradeTaskSuccess(session({ workPlan: plan, ledger: WORK })).verdict).toBe('success');
  });

  it('fails a finished plan with outstanding ENG-1811 removed-step debt', () => {
    const r = gradeTaskSuccess(session({ workPlan: { steps: steps('completed'), pendingRequiredFunctionCalls: ['publish_blog_article'] }, ledger: WORK }));
    expect(r).toMatchObject({ verdict: 'failure', reason: 'required_function_never_succeeded', detail: 'publish_blog_article' });
  });
});

const CUSTOMER = '1234567890';
const CAMPAIGN_RN = `customers/${CUSTOMER}/campaigns/24011409538`;

/** ENG-286: CAMPAIGN UPDATE to TARGET_SPEND reported success and changed nothing. */
function eng286Update(): LedgerCall {
  return call(
    'call_google_ads_api',
    { customer_id: CUSTOMER, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN_RN, bidding_strategy: 'TARGET_SPEND' },
    { result: {}, output: { success: true, message: 'Campaign updated' } },
  );
}

function gaql(query: string, extra: Partial<LedgerCall> = {}, customer = CUSTOMER): LedgerCall {
  return call('call_google_ads_reporting_api', { customer_id: customer, mode: 'raw', query }, extra);
}

const kinds = (r: ToolCorrectnessResult) => r.findings.map((f) => f.kind);

describe('gradeToolCorrectness: loop-event failure classes', () => {
  it('flags invalid args, policy blocks and uninstalled tools', () => {
    const r = gradeToolCorrectness({
      ledger: [],
      events: [
        ev('agent_tool_invoked', { toolName: 'a' }),
        ev('agent_tool_failed', { toolName: 'a', errorClass: 'invalid_args' }),
        ev('agent_tool_failed', { toolName: 'b', errorClass: 'Error', failureType: 'schema_reject' }),
        ev('agent_tool_failed', { toolName: 'c', errorClass: 'policy_blocked', failureType: 'by_design' }),
        ev('agent_tool_failed', { toolName: 'd', errorClass: 'tool_unavailable', failureType: 'model_uninstalled_tool' }),
        ev('agent_tool_failed', { toolName: 'e', errorClass: 'timeout', failureType: 'bug' }),
      ],
    });
    expect(r.verdict).toBe('fail');
    expect(kinds(r)).toEqual(['invalid_args', 'invalid_args', 'policy_blocked', 'uninstalled_tool']);
  });

  it('flags one repeated failure per tool at 3 failures within a run, not across runs', () => {
    const fail = (runId: string) => ev('agent_tool_failed', { toolName: 'x', errorClass: 'timeout' }, runId);
    expect(kinds(gradeToolCorrectness({ ledger: [], events: [fail('r1'), fail('r1'), fail('r2'), fail('r2')] }))).toEqual([]);
    const r = gradeToolCorrectness({ ledger: [], events: [fail('r1'), fail('r1'), fail('r1'), fail('r1')] });
    expect(r.findings).toEqual([{ kind: 'repeated_failure', toolName: 'x', runId: 'r1', detail: '3 failures' }]);
    expect(kinds(gradeToolCorrectness({ ledger: [], events: [ev('agent_tool_failed', { toolName: 'y', errorClass: 'repeated_failure' })] })))
      .toEqual(['repeated_failure']);
  });

  it('passes a clean run', () => {
    const r = gradeToolCorrectness({ ledger: [call('you_search_web')], events: [ev('agent_tool_invoked'), ev('agent_tool_succeeded')] });
    expect(r).toEqual({ verdict: 'pass', toolCalls: 1, mutations: 0, findings: [] });
  });
});

describe('gradeToolCorrectness: write without read-back (ENG-592 grader side)', () => {
  it('flags the ENG-286 success-but-no-op that the run verdict grades ok', () => {
    const ledger = [eng286Update()];
    // The existing runtime verdict sees one successful call and no failures.
    expect(computeRunVerdict({ failed: false, toolCalls: 1, failedToolCalls: 0 }).verdict).toBe('ok');
    const r = gradeToolCorrectness({ ledger, events: [] });
    expect(r.verdict).toBe('fail');
    expect(r.mutations).toBe(1);
    expect(r.findings).toEqual([{ kind: 'write_without_read_back', toolName: 'call_google_ads_api', callId: ledger[0].id, detail: 'CAMPAIGN UPDATE' }]);
  });

  it('replays ENG-286 through the ENG-591 replay harness: red on the run verdict, green on the grader', async () => {
    type Out = { flagged: boolean };
    const replay: FailureReplayCase<LedgerCall[], Out> = {
      id: 'eng-286-success-but-no-op-grader',
      incident: 'ENG-286',
      input: [eng286Update()],
      assert: (out) => out.flagged,
      failure: 'A Google Ads write that reported success with no read-back must be flagged',
    };
    const runVerdict = (ledger: LedgerCall[]): Out => ({
      flagged: computeRunVerdict({ failed: false, toolCalls: ledger.length, failedToolCalls: 0 }).verdict !== 'ok',
    });
    const grader = (ledger: LedgerCall[]): Out => ({ flagged: kinds(gradeToolCorrectness({ ledger, events: [] })).includes('write_without_read_back') });
    await expect(evaluateReplayCase(replay, runVerdict)).resolves.toMatchObject({ passed: false, incident: 'ENG-286' });
    await expect(evaluateReplayCase(replay, grader)).resolves.toMatchObject({ passed: true });
  });

  it('flags the same write sent twice (the ENG-286 retry) even when it was read back in between', () => {
    const r = gradeToolCorrectness({
      ledger: [eng286Update(), gaql('SELECT campaign.bidding_strategy_type FROM campaign WHERE campaign.id = 24011409538'), eng286Update()],
      events: [],
    });
    expect(kinds(r)).toEqual(['repeated_mutation', 'write_without_read_back']);
    expect(r.mutations).toBe(2);
  });

  it('accepts a later GAQL read of the same object', () => {
    const r = gradeToolCorrectness({ ledger: [eng286Update(), gaql('SELECT campaign.bidding_strategy_type FROM campaign WHERE campaign.id = 24011409538')], events: [] });
    expect(r.verdict).toBe('pass');
  });

  it('accepts an unfiltered read of the same entity type, but not a read of another type', () => {
    expect(gradeToolCorrectness({ ledger: [eng286Update(), gaql('SELECT campaign.id, campaign.bidding_strategy_type FROM campaign')], events: [] }).verdict)
      .toBe('pass');
    expect(kinds(gradeToolCorrectness({ ledger: [eng286Update(), gaql('SELECT ad_group.id FROM ad_group')], events: [] })))
      .toEqual(['write_without_read_back']);
  });

  it('reports, without failing, a same-type read whose filter names other objects', () => {
    const r = gradeToolCorrectness({ ledger: [eng286Update(), gaql('SELECT campaign.id FROM campaign WHERE campaign.id = 99999999')], events: [] });
    expect(r).toMatchObject({ verdict: 'pass', findings: [{ kind: 'write_read_back_unconfirmed', detail: 'CAMPAIGN UPDATE' }] });
  });

  it('accepts a read of another resource that names the object id', () => {
    const update = call('call_google_ads_api', { customer_id: CUSTOMER, entity_type: 'AD_GROUP', action: 'UPDATE', ad_group_resource_name: `customers/${CUSTOMER}/adGroups/777777777`, status: 'PAUSED' });
    expect(gradeToolCorrectness({ ledger: [update, gaql('SELECT ad_group.status FROM keyword_view WHERE ad_group.id = 777777777')], events: [] }).verdict)
      .toBe('pass');
  });

  it('accepts a call_google_ads_api LIST and a serving-chain check as reads', () => {
    const list = call('call_google_ads_api', { customer_id: CUSTOMER, entity_type: 'CAMPAIGN', action: 'LIST' });
    expect(gradeToolCorrectness({ ledger: [eng286Update(), list], events: [] }).verdict).toBe('pass');
    const chain = call('call_google_ads_reporting_api', { customer_id: CUSTOMER, mode: 'serving_chain', campaign_ids: ['24011409538'] });
    expect(gradeToolCorrectness({ ledger: [eng286Update(), chain], events: [] }).verdict).toBe('pass');
  });

  it('does not accept a read on another account, a read before the write, or a failed read', () => {
    const read = 'SELECT campaign.bidding_strategy_type FROM campaign WHERE campaign.id = 24011409538';
    expect(kinds(gradeToolCorrectness({ ledger: [eng286Update(), gaql(read, {}, '5555555555')], events: [] }))).toEqual(['write_without_read_back']);
    expect(kinds(gradeToolCorrectness({ ledger: [gaql(read), eng286Update()], events: [] }))).toEqual(['write_without_read_back']);
    expect(kinds(gradeToolCorrectness({ ledger: [eng286Update(), gaql(read, { status: 'error' })], events: [] }))).toEqual(['write_without_read_back']);
    expect(kinds(gradeToolCorrectness({ ledger: [eng286Update(), gaql(read, { output: { success: false, error: 'PERMISSION_DENIED' } })], events: [] })))
      .toEqual(['write_without_read_back']);
  });

  it('takes a created object id from the tool output', () => {
    const create = call(
      'call_google_ads_api',
      { customer_id: CUSTOMER, entity_type: 'AD_GROUP', action: 'CREATE', campaign_resource_name: CAMPAIGN_RN, name: 'g' },
      { output: { success: true, adGroupResourceName: `customers/${CUSTOMER}/adGroups/777777777` } },
    );
    expect(gradeToolCorrectness({ ledger: [create, gaql('SELECT ad_group.status FROM ad_group WHERE ad_group.id = 777777777')], events: [] }).verdict)
      .toBe('pass');
  });

  it('accepts a create whose new id a later successful call on the account uses', () => {
    const creative = call('call_meta_marketing_api', { account_id: '123456', entity_type: 'AD_CREATIVE', action: 'CREATE' }, { output: { success: true, id: '120200000000077' } });
    const ad = call('call_meta_marketing_api', { account_id: '123456', entity_type: 'AD', action: 'CREATE', ad_set_id: '120200000000009', params: { creative: { creative_id: '120200000000077' } } }, { output: { success: true, id: '120200000000078' } });
    const failedAd = { ...ad, status: 'error' as const };
    expect(kinds(gradeToolCorrectness({ ledger: [creative, ad], events: [] }))).toEqual(['write_without_read_back']); // only the ad itself
    expect(kinds(gradeToolCorrectness({ ledger: [creative, failedAd], events: [] }))).toEqual(['write_without_read_back']);
    expect(gradeToolCorrectness({ ledger: [creative, failedAd], events: [] }).findings[0].callId).toBe(creative.id);
  });

  it('ignores writes that did not execute or were not reported as successes', () => {
    const halted = { ...eng286Update(), output: { success: true, awaitingUserConfirmation: true } };
    const blocked = { ...eng286Update(), result: { success: false, blocked: true, reason: 'tracking_preflight' } };
    const errored = { ...eng286Update(), status: 'error' as const };
    const validateOnly = call('call_google_ads_api', { customer_id: CUSTOMER, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN_RN, validate_only: true });
    const upload = call('call_google_ads_api', { customer_id: CUSTOMER, entity_type: 'OFFLINE_CONVERSION', action: 'UPLOAD', gclid: 'g' });
    const r = gradeToolCorrectness({ ledger: [halted, blocked, errored, validateOnly, upload], events: [] });
    expect(r).toMatchObject({ verdict: 'pass', mutations: 0 });
  });

  it('trusts a tool that read the object back itself', () => {
    const meta = call(
      'call_meta_marketing_api',
      { account_id: 'act_123456', entity_type: 'AD_SET', action: 'CREATE', campaign_id: '120200000000001' },
      { output: { success: true, id: '120200000000002', readBackVerified: true } },
    );
    const cap = call('call_meta_marketing_api', { account_id: '123456', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '120200000000001' }, { output: { success: true, spend_cap_verified: true } });
    const conversion = call('call_google_ads_api', { customer_id: CUSTOMER, entity_type: 'CONVERSION_ACTION', action: 'UPDATE' }, { output: { success: true, drift: [] } });
    expect(gradeToolCorrectness({ ledger: [meta, cap, conversion], events: [] })).toMatchObject({ verdict: 'pass', mutations: 3 });
  });

  it('covers Meta and LinkedIn writes read back through GET/LIST on the same account', () => {
    const update = call('call_meta_marketing_api', { account_id: 'act_123456', entity_type: 'AD_SET', action: 'UPDATE', ad_set_id: '120200000000009' }, { output: { success: true } });
    const get = call('call_meta_marketing_api', { account_id: '123456', entity_type: 'AD_SET', action: 'GET', ad_set_id: '120200000000009' });
    expect(gradeToolCorrectness({ ledger: [update, get], events: [] }).verdict).toBe('pass');
    expect(kinds(gradeToolCorrectness({ ledger: [update], events: [] }))).toEqual(['write_without_read_back']);

    const li = call('call_linkedin_marketing_api', { account_id: '50000001', entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '60000001' });
    const liList = call('call_linkedin_marketing_api', { account_id: '50000001', entity_type: 'CAMPAIGN', action: 'LIST' });
    expect(gradeToolCorrectness({ ledger: [li, liList], events: [] }).verdict).toBe('pass');
    expect(kinds(gradeToolCorrectness({ ledger: [li], events: [] }))).toEqual(['write_without_read_back']);
  });

  it('does not treat reads, searches or non-ad tools as writes', () => {
    const r = gradeToolCorrectness({
      ledger: [
        call('call_google_ads_api', { customer_id: CUSTOMER, entity_type: 'LOCATION', action: 'SEARCH', query: 'x' }),
        call('call_meta_marketing_api', { account_id: '1', entity_type: 'TARGETING', action: 'SEARCH' }),
        call('update_lead_status', { lead_id: '123456' }),
      ],
      events: [],
    });
    expect(r).toMatchObject({ verdict: 'pass', mutations: 0 });
  });
});

describe('gradeGroundedness (finalize-guard claim classes, offline)', () => {
  it('reports no claims when the lexicon finds none', () => {
    expect(gradeGroundedness('Here are three options for next week.', []).verdict).toBe('no_claims');
    expect(gradeGroundedness(undefined, []).verdict).toBe('no_claims');
  });

  it('flags a completion claim with no successful matching tool call', () => {
    const r = gradeGroundedness('Done: the email was sent to all 40 leads.', [call('get_leads')]);
    expect(r).toEqual({ verdict: 'ungrounded', claimClasses: ['email_sent'], unbackedClaimClasses: ['email_sent'], ambiguousClaimClasses: [] });
  });

  it('accepts the claim when the matching tool succeeded', () => {
    expect(gradeGroundedness('Done: the email was sent to all 40 leads.', [call('send_email')]).verdict).toBe('grounded');
  });

  it('does not accept a failed or encoded-failure call as backing', () => {
    expect(gradeGroundedness('The email was sent.', [call('send_email', {}, { status: 'error' })]).verdict).toBe('ungrounded');
    expect(gradeGroundedness('The email was sent.', [call('send_email', {}, { result: { success: false, error: 'bounced' } })]).verdict).toBe('ungrounded');
  });

  it('treats a confirmation-gate pause as no asset (the xCures case)', () => {
    const paused = call('generate_image', {}, { result: { success: true, awaitingUserConfirmation: true } });
    expect(gradeGroundedness('I generated 18 images for the campaign.', [paused]).unbackedClaimClasses).toEqual(['asset_generated']);
  });

  it('reports a loose-only tool match as ambiguous, not unbacked, like the runtime guard', () => {
    const r = gradeGroundedness('The task was created in ClickUp.', [call('clickup_task_manager')]);
    expect(r).toMatchObject({ verdict: 'grounded', unbackedClaimClasses: [], ambiguousClaimClasses: ['task_created_or_updated'] });
  });
});

describe('efficiencyMetrics', () => {
  const input = (task: EfficiencyInput['task'], costUsd?: number, extra: Partial<EfficiencyInput> = {}): EfficiencyInput => ({
    task,
    userTurns: 2,
    toolDurationsMs: [],
    ...(costUsd != null ? { spend: { costMicroUsd: costUsd * 1e6, tokens: 1000 } } : {}),
    ...extra,
  });

  it('computes rate with a Wilson CI, and cost per success charging failures to successes', () => {
    const r = efficiencyMetrics([
      input('success', 1, { userTurns: 2, toolDurationsMs: [100, 300] }),
      input('success', 3, { userTurns: 4, toolDurationsMs: [200] }),
      input('failure', 2),
      input('excluded', 50),
    ]);
    expect(r).toMatchObject({
      graded: 3,
      successes: 2,
      successRate: 2 / 3,
      successRateCI: wilsonInterval(2, 3),
      meanTurnsPerSuccess: 3,
      meanTokensPerSuccess: 1000,
      costPerSuccessUsd: 3,
      medianSuccessCostUsd: 1,
      gradedWithSpend: 3,
      toolLatencyP50Ms: 200,
      toolLatencyP95Ms: 300,
    });
  });

  it('reports cost only over sessions with spend data', () => {
    const r = efficiencyMetrics([input('success'), input('failure', 4), input('success', 2)]);
    expect(r).toMatchObject({ gradedWithSpend: 2, costPerSuccessUsd: 6, medianSuccessCostUsd: 2 });
  });

  it('returns nulls, not NaN, when nothing is graded', () => {
    expect(efficiencyMetrics([input('excluded', 1)])).toEqual({
      graded: 0,
      successes: 0,
      successRate: null,
      successRateCI: null,
      meanTurnsPerSuccess: null,
      meanTokensPerSuccess: null,
      costPerSuccessUsd: null,
      medianSuccessCostUsd: null,
      gradedWithSpend: 0,
      toolLatencyP50Ms: null,
      toolLatencyP95Ms: null,
    });
  });
});

describe('task type and aggregation', () => {
  it('buckets work-plan titles by keyword, first match wins', () => {
    expect(classifyTaskType('Launch Google Ads Search campaign')).toBe('ads');
    expect(classifyTaskType('Build a landing page for the webinar')).toBe('landing_page');
    expect(classifyTaskType('LinkedIn outreach to 50 prospects')).toBe('outreach');
    expect(classifyTaskType('Write 3 blog posts')).toBe('content');
    expect(classifyTaskType('Competitor research')).toBe('research');
    expect(classifyTaskType('Plan my week')).toBe('other');
    expect(classifyTaskType(undefined)).toBe('other');
  });

  it('grades a session end to end and aggregates per model x task type', () => {
    const adsSession = session({
      sessionId: 'a',
      workPlan: { title: 'Switch campaign bidding', steps: steps('completed') },
      ledger: [eng286Update()],
      events: [ev('agent_tool_invoked', { toolName: 'call_google_ads_api' }), ev('agent_tool_succeeded', { toolName: 'call_google_ads_api', durationMs: 900 })],
      finalReply: 'Your campaign now uses Maximize Clicks.',
    });
    const graded = [
      gradeSession(adsSession, 'm1', { costMicroUsd: 2e6, tokens: 500 }),
      gradeSession(session({ sessionId: 'b', workPlan: { title: 'Ads audit', steps: steps('pending', 'pending') }, ledger: WORK }), 'm1', undefined),
      gradeSession(session({ sessionId: 'c', ledger: WORK }), 'm2', undefined),
    ];
    expect(graded[0]).toMatchObject({ taskType: 'ads', task: { verdict: 'success' }, efficiency: { toolDurationsMs: [900] } });

    const groups = aggregateByModelAndTaskType(graded);
    expect(groups.map((g) => [g.model, g.taskType, g.sessions, g.graded])).toEqual([['m1', 'ads', 2, 2], ['m2', 'other', 1, 0]]);
    expect(groups[0]).toMatchObject({
      successes: 1,
      successWithUnverifiedWrite: 1,
      writeWithoutReadBackSessions: 1,
      toolFailSessions: 1,
      costPerSuccessUsd: 2,
      gradedWithSpend: 1,
    });
    expect(groups[1]).toMatchObject({ excluded: 1, successRate: null });
  });
});

describe('eval registry entries', () => {
  it.each(['agent-task-success', 'agent-tool-correctness', 'agent-groundedness-offline'])('registers %s as an unvalidated code grader', (id) => {
    expect(getGrader(id)).toMatchObject({ surface: 'agent', graderType: 'code', modelFamily: 'none' });
    expect(mayGate(id)).toBe(false);
  });
});
