import { AgentFailureRuleSet } from '../loops/instances/agent-mode/failureRuleSet';
import { registerAgentModeLoop, _internal } from '../loops/instances/agent-mode';
import { getLearningStore, getRuleSet, _resetRegistryForTesting } from '../loops';
import { AGENT_MODE_LOOP_ID, EVT_TOOL_FAILED, EVT_TOOL_INVOKED } from '../loops/instances/agent-mode/eventTypes';
import { asSubjectId, asMutationId, asRunId } from '../loops/core/types';
import type { LearningRecord, NormalizedEvent, TimeWindow } from '../loops/core/types';

const window: TimeWindow = { start: new Date('2026-09-01'), end: new Date('2026-09-08') };
function events(toolName = 'mixed:tool'): NormalizedEvent[] {
  const event = (eventType: string, extra = {}): NormalizedEvent => ({
    subjectId: asSubjectId('session'), ts: window.start, eventType,
    dimensions: { toolName, ...extra },
  });
  return [
    ...Array.from({ length: 20 }, () => event(EVT_TOOL_INVOKED)),
    ...[['config', 8, 'auth', 'token expired'], ['bug', 6, 'TypeError', 'undefined field'],
      ['schema_reject', 4, 'invalid_args', 'missing argument']].flatMap(([failureType, count, errorClass, errorMessage]) =>
      Array.from({ length: Number(count) }, () => event(EVT_TOOL_FAILED, { failureType, errorClass, errorMessage }))),
  ];
}
function history(ruleId: string, verdict: LearningRecord['verdict'] = null, shippedAt = window.start): LearningRecord {
  return { loopId: AGENT_MODE_LOOP_ID, runId: asRunId('old'), ts: shippedAt, shippedAt,
    sortKey: shippedAt.toISOString(), verdict,
    proposal: { proposalId: asMutationId('old'), sourceRuleId: ruleId, kind: 'code_change', hypothesis: 'old', payload: {}, triggeringStats: {} } };
}

beforeEach(() => { _resetRegistryForTesting(); _internal.resetForTesting(); registerAgentModeLoop(); });
afterEach(() => { jest.restoreAllMocks(); _resetRegistryForTesting(); _internal.resetForTesting(); });
function policy(records: LearningRecord[] = []) {
  jest.spyOn(getLearningStore('agentModeLearning'), 'queryHistory').mockResolvedValue(records);
  return getRuleSet('agentModeFailurePolicy');
}

it('emits a separate remediation with coherent evidence for each actionable class', async () => {
  const proposals = await policy().evaluate(events(), window);
  expect(proposals).toHaveLength(3);
  for (const [i, [failureType, failures, errorClass, message, action]] of [
    ['config', 8, 'auth', 'token expired', 'reconnect'],
    ['bug', 6, 'TypeError', 'undefined field', 'Reproduce'],
    ['schema_reject', 4, 'invalid_args', 'missing argument', 'JSON schema'],
  ].entries()) {
    expect(proposals[i].sourceRuleId).toBe(`tool-failure:mixed:tool:${failureType}`);
    expect(proposals[i].payload).toMatchObject({ failureType, failures, failureRate: Number(failures) / 20, topErrorClass: errorClass });
    const payload = proposals[i].payload as { directive: string };
    expect(payload.directive).toContain(`"${message}"`);
    expect(payload.directive).toContain(action);
  }
  expect(new Set(proposals.map(p => p.proposalId)).size).toBe(3);
});

it.each([null, 'regressed', 'no_change', 'inconclusive'] as const)('legacy %s cooldown suppresses all new classes but not other tools', async verdict => {
  const records = [history('tool-failure:mixed:tool', verdict)];
  const proposals = await policy(records).evaluate([...events(), ...events('other')], window);
  expect(proposals.map(p => p.sourceRuleId)).toEqual([
    'tool-failure:other:config', 'tool-failure:other:bug', 'tool-failure:other:schema_reject',
  ]);
  expect(records[0].proposal!.sourceRuleId).toBe('tool-failure:mixed:tool');
});

it('a class cooldown suppresses only its own class', async () => {
  const proposals = await policy([history('tool-failure:mixed:tool:config')]).evaluate(events(), window);
  expect(proposals.map(p => p.sourceRuleId)).toEqual(['tool-failure:mixed:tool:bug', 'tool-failure:mixed:tool:schema_reject']);
});

it.each(['improved', 'expired'] as const)('releases a legacy %s cooldown', async mode => {
  const old = history('tool-failure:mixed:tool', mode === 'improved' ? 'improved' : 'no_change',
    mode === 'expired' ? new Date('2026-08-01') : window.start);
  expect(await policy([old]).evaluate(events(), window)).toHaveLength(3);
});

it('does not let a newer improved class outcome bypass an active legacy cooldown', async () => {
  const newer = history('tool-failure:mixed:tool:config', 'improved', new Date('2026-09-07'));
  expect(await policy([history('tool-failure:mixed:tool'), newer]).evaluate(events(), window)).toEqual([]);
});

it('uses the latest shipped legacy outcome and ignores unshipped decisions', async () => {
  const improved = history('tool-failure:mixed:tool', 'improved', new Date('2026-09-06'));
  const unshipped = { ...history('tool-failure:mixed:tool', null, new Date('2026-09-07')), shippedAt: null };
  expect(await policy([history('tool-failure:mixed:tool'), unshipped, improved]).evaluate(events(), window)).toHaveLength(3);
});

it('reads history once while enforcing both legacy and class cooldown identities', async () => {
  const store = getLearningStore('agentModeLearning');
  const query = jest.spyOn(store, 'queryHistory').mockResolvedValue([history('tool-failure:mixed:tool:config')]);
  const proposals = await getRuleSet('agentModeFailurePolicy').evaluate(events(), window);
  expect(query).toHaveBeenCalledTimes(1);
  expect(proposals.map(p => p.sourceRuleId)).toEqual(['tool-failure:mixed:tool:bug', 'tool-failure:mixed:tool:schema_reject']);
});

it('redacts secrets and identifiers from representative failure text', async () => {
  const sensitive = 'Bearer abc.def api_key=sk-secret email=user@example.com account_id=acct_123';
  const proposals = await policy().evaluate(events().map(e => e.eventType === EVT_TOOL_FAILED
    ? { ...e, dimensions: { ...e.dimensions, errorMessage: sensitive } } : e), window);
  const directives = proposals.map(p => (p.payload as { directive: string }).directive).join('\n');
  expect(directives).not.toContain('abc.def');
  expect(directives).not.toContain('sk-secret');
  expect(directives).toContain('[REDACTED]');
});

it('counts unique tools before and after truncation, excluding whole-run findings', () => {
  const proposals = [{ payload: { occurrences: 3 } }, { payload: { toolName: 'a' } },
    { payload: { toolName: 'a' } }, { payload: { toolName: 'a' } }, { payload: { toolName: 'b' } }];
  const counts = _internal.digestTemplate().counts;
  expect(counts({ proposals, eventsScanned: 50 } as any, 0)).toContain('Failing tools: 2');
  expect(counts({ proposals: proposals.slice(0, 3), uncappedProposals: proposals,
    proposalsTruncated: 2, eventsScanned: 50 } as any, 0)).toContain('showing 1 of 2');
  expect(counts({ proposals: proposals.slice(0, 2), uncappedProposals: proposals.slice(0, 4),
    proposalsTruncated: 2, eventsScanned: 50 } as any, 0)).toContain('Failing tools: 1');
});

it('keeps non-actionable failure classes excluded', async () => {
  const nonActionable = events().map(e => e.eventType === EVT_TOOL_FAILED
    ? { ...e, dimensions: { ...e.dimensions, failureType: 'by_design' } } : e);
  expect(await new AgentFailureRuleSet().evaluate(nonActionable, window)).toEqual([]);
});
