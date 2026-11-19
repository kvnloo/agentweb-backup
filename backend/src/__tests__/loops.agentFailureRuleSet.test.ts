/**
 * Tests for the agent-mode failure-pattern policy.
 *
 * The policy turns a window of agent-run events into proposals: for any tool
 * whose failures cluster (>= minFailures AND failure-rate >= minFailureRate
 * over the window), propose a cloud-dev fix spec carrying the exact failure
 * signature — the "repeated pattern + exact proposed fix" the audit asks for.
 * Healthy tools and one-off blips produce nothing.
 */

import { AgentFailureRuleSet, isNeverConnectedMessage } from '../loops/instances/agent-mode/failureRuleSet';
import {
  EVT_RUN_STARTED,
  EVT_RUN_VERDICT,
  EVT_TOOL_FAILED,
  EVT_TOOL_INVOKED,
  EVT_TOOL_SUCCEEDED,
} from '../loops/instances/agent-mode/eventTypes';
import type { NormalizedEvent, TimeWindow } from '../loops/core/types';
import { asSubjectId } from '../loops/core/types';

const WINDOW: TimeWindow = {
  start: new Date('2026-06-01T00:00:00Z'),
  end: new Date('2026-06-08T00:00:00Z'),
};

let seq = 0;
function evt(
  eventType: string,
  toolName: string,
  extra: Record<string, string | number | boolean | null> = {},
): NormalizedEvent {
  seq++;
  return {
    subjectId: asSubjectId(`session-${seq}`),
    eventType,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { toolName, ...extra },
  };
}

function invoked(toolName: string, n: number): NormalizedEvent[] {
  return Array.from({ length: n }, () => evt(EVT_TOOL_INVOKED, toolName));
}
function failed(toolName: string, n: number, errorClass = 'TimeoutError'): NormalizedEvent[] {
  return Array.from({ length: n }, () => evt(EVT_TOOL_FAILED, toolName, { errorClass }));
}
function succeeded(toolName: string, n: number): NormalizedEvent[] {
  return Array.from({ length: n }, () => evt(EVT_TOOL_SUCCEEDED, toolName));
}

/** A run_verdict event, as emitVerdict() writes it — no toolName dimension. */
function verdict(reasons: string[], sessionId = `session-${++seq}`): NormalizedEvent {
  return {
    subjectId: asSubjectId(sessionId),
    eventType: EVT_RUN_VERDICT,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { verdict: reasons.length > 0 ? 'degraded' : 'ok', reasons: reasons.join(','), sessionId },
  };
}

describe('AgentFailureRuleSet', () => {
  const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });

  it('proposes a fix for a tool whose failures clear both thresholds', async () => {
    const events = [
      ...invoked('generate_image', 10),
      ...failed('generate_image', 4),
      ...succeeded('generate_image', 6),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.kind).toBe('code_change');
    expect(p.sourceRuleId).toBe('tool-failure:generate_image:unclassified');
    expect(p.payload).toEqual(
      expect.objectContaining({ toolName: 'generate_image', failures: 4, invocations: 10 }),
    );
    // triggering stats carry the dominant error class for the fix spec
    expect(p.triggeringStats).toEqual(
      expect.objectContaining({ toolName: 'generate_image', topErrorClass: 'TimeoutError' }),
    );
  });

  it('does NOT propose when failures are below the count threshold', async () => {
    const events = [...invoked('send_email', 20), ...failed('send_email', 2), ...succeeded('send_email', 18)];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(0);
  });

  it('does NOT propose when the failure rate is below threshold even if count is high', async () => {
    // 5 failures but out of 100 invocations = 5% < 20%
    const events = [...invoked('search', 100), ...failed('search', 5), ...succeeded('search', 95)];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(0);
  });

  it('proposes independently per tool and sorts the worst-rate tool first', async () => {
    const events = [
      ...invoked('alpha', 10),
      ...failed('alpha', 3), // 30%
      ...invoked('beta', 10),
      ...failed('beta', 8), // 80%
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.map((p) => p.payload).map((x: any) => x.toolName)).toEqual(['beta', 'alpha']);
  });

  it('uses the most frequent error class as the failure signature', async () => {
    const events = [
      ...invoked('publish_post', 10),
      ...failed('publish_post', 1, 'AuthError'),
      ...failed('publish_post', 3, 'RateLimitError'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].triggeringStats).toEqual(
      expect.objectContaining({ topErrorClass: 'RateLimitError' }),
    );
  });

  it('returns nothing for an empty window', async () => {
    expect(await policy.evaluate([], WINDOW)).toEqual([]);
  });

  it('ignores failures with no toolName dimension (cannot attribute a fix)', async () => {
    const orphan: NormalizedEvent = {
      subjectId: asSubjectId('s-x'),
      eventType: EVT_TOOL_FAILED,
      ts: new Date('2026-06-04T00:00:00Z'),
    };
    const proposals = await policy.evaluate([orphan, orphan, orphan, orphan], WINDOW);
    expect(proposals).toHaveLength(0);
  });
});

/**
 * claim_mismatch clustering (ENG-143 gap): the finalize guard writes
 * agent_run_verdict events with reasons including 'claim_mismatch', but until
 * now nothing clustered them — the 17:30 UTC cron only ever scanned
 * agent_tool_invoked/agent_tool_failed, so a real truthfulness problem could
 * fire the guard every day and nobody would be told. These events carry no
 * toolName dimension (they're a whole-run verdict, not a per-tool outcome),
 * so they cannot flow through the per-tool clustering above — they need their
 * own aggregate count across the window.
 */
describe('AgentFailureRuleSet — claim_mismatch clustering (ENG-143)', () => {
  const policy = new AgentFailureRuleSet({ minClaimMismatches: 2 });

  it('proposes a truthfulness fix once claim_mismatch verdicts cross the threshold', async () => {
    const events = [
      verdict(['claim_mismatch'], 's-1'),
      verdict(['claim_mismatch'], 's-2'),
      verdict([], 's-3'), // clean run — must not count
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    const claimProposal = proposals.find((p) => p.sourceRuleId === 'claim-mismatch:truthfulness');
    expect(claimProposal).toBeDefined();
    expect(claimProposal!.kind).toBe('code_change');
    expect(claimProposal!.payload).toEqual(
      expect.objectContaining({ occurrences: 2, sessionIds: ['s-1', 's-2'] }),
    );
    expect(claimProposal!.triggeringStats).toEqual(expect.objectContaining({ occurrences: 2 }));
  });

  it('does NOT propose below the threshold', async () => {
    const events = [verdict(['claim_mismatch'], 's-1'), verdict([], 's-2'), verdict([], 's-3')];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.find((p) => p.sourceRuleId === 'claim-mismatch:truthfulness')).toBeUndefined();
  });

  it('ignores run_verdict events whose reasons do not include claim_mismatch', async () => {
    const events = [
      verdict(['failed_tool_calls'], 's-1'),
      verdict(['high_failure_ratio'], 's-2'),
      verdict(['repeated_tool_failures'], 's-3'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.find((p) => p.sourceRuleId === 'claim-mismatch:truthfulness')).toBeUndefined();
  });

  it('coexists with per-tool failure proposals in the same window', async () => {
    const events = [
      ...invoked('generate_image', 10),
      ...failed('generate_image', 4),
      verdict(['claim_mismatch'], 's-1'),
      verdict(['claim_mismatch'], 's-2'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.map((p) => p.sourceRuleId).sort()).toEqual(
      ['claim-mismatch:truthfulness', 'tool-failure:generate_image:unclassified'].sort(),
    );
  });

  it('sorts the claim-mismatch proposal FIRST regardless of tool failure rate', async () => {
    const events = [
      // 90% failure rate — would sort first under the old tool-only comparator
      ...invoked('generate_image', 10),
      ...failed('generate_image', 9),
      verdict(['claim_mismatch'], 's-1'),
      verdict(['claim_mismatch'], 's-2'),
    ];
    const proposals = await policy.evaluate(events, WINDOW);
    expect(proposals.map((p) => p.sourceRuleId)).toEqual([
      'claim-mismatch:truthfulness',
      'tool-failure:generate_image:unclassified',
    ]);
  });
});

describe('AgentFailureRuleSet — never-connected precondition (ENG-2943)', () => {
  const rs = new AgentFailureRuleSet();
  const fail = (tool: string, n: number, errorMessage: string) =>
    Array.from({ length: n }, () => evt(EVT_TOOL_FAILED, tool, { errorClass: 'Error', failureType: 'config', errorMessage }));

  it.each([
    'No Fathom account connected. Please connect your Fathom account in Settings.',
    'No Gmail account connected. Please connect your Gmail account in Settings → Connected Accounts.',
    'No HubSpot account connected',
    'No LinkedIn Outreach account connected.',
  ])('excludes "%s" from admission', async (msg) => {
    const out = await rs.evaluate([...invoked('t', 7), ...fail('t', 5, msg)], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('still files genuine auth failures on a connected account as config', async () => {
    const out = await rs.evaluate(
      [...invoked('t', 7), ...fail('t', 2, 'No Fathom account connected.'), ...fail('t', 4, 'invalid_grant: token expired or revoked')],
      WINDOW,
    );
    expect(out).toHaveLength(1);
    const p: any = out[0].payload;
    expect(p.failureType).toBe('config');
    expect(p.failures).toBe(4);
    expect(JSON.stringify(out[0])).toContain('2 non-actionable excluded');
  });

  it('does not match missing-scope wording', async () => {
    const out = await rs.evaluate([...invoked('t', 5), ...fail('t', 4, 'Missing scope ads_management on connected account')], WINDOW);
    expect(out).toHaveLength(1);
  });
});

describe('AgentFailureRuleSet — "<X> not connected" precondition wording (ENG-3037)', () => {
  const rs = new AgentFailureRuleSet();
  const fail = (tool: string, n: number, errorMessage: string) =>
    Array.from({ length: n }, () => evt(EVT_TOOL_FAILED, tool, { errorClass: 'Error', failureType: 'config', errorMessage }));

  // Exact strings thrown on main when NO connected-account row exists.
  const GOOGLE_DRIVE = 'Google Drive not connected. Connect Google Drive in Settings → Connected Accounts.';
  const NO_ROW_MESSAGES = [
    GOOGLE_DRIVE,
    'HubSpot account not connected. Please connect your HubSpot account in Settings.',
    'Gmail account not connected. Please connect your Gmail account in Settings → Connected Accounts.',
    'Outlook account not connected. Please connect your Microsoft 365 mailbox in Settings → Connected Accounts.',
    'Attio account not connected. Please connect your Attio account in Settings.',
  ];

  it.each(NO_ROW_MESSAGES)('classifies "%s" as not_connected and files nothing', async (msg) => {
    expect(isNeverConnectedMessage(msg)).toBe(true);
    const out = await rs.evaluate([...invoked('t', 7), ...fail('t', 5, msg)], WINDOW);
    expect(out).toHaveLength(0);
  });

  it('still matches when the message arrives wrapped by a caller prefix', () => {
    expect(isNeverConnectedMessage(`Tool google_drive failed: ${GOOGLE_DRIVE}`)).toBe(true);
  });

  it('excludes the Google Drive precondition when mixed with real failures of the same tool', async () => {
    const out = await rs.evaluate(
      [...invoked('google_drive', 18), ...fail('google_drive', 5, GOOGLE_DRIVE), ...fail('google_drive', 4, 'invalid_grant: token expired or revoked')],
      WINDOW,
    );
    expect(out).toHaveLength(1);
    const p: any = out[0].payload;
    expect(p.failureType).toBe('config');
    expect(p.failures).toBe(4);
    expect(p.directive).toContain('invalid_grant');
    expect(JSON.stringify(out[0])).toContain('5 non-actionable excluded');
  });

  // Each of these can be produced by an account that IS connected (or names one
  // specific configured account), so someone can act on it: it stays dispatchable.
  it.each([
    'invalid_grant: token expired or revoked',
    'Google Drive authorization has expired or is not connected. Reconnect Google Drive in Settings → Connected Accounts, then retry.',
    'Missing scope ads_management on connected account',
    'LinkedIn Ads account "123" is not connected. Connect it in Settings before running the UTM audit.',
    // adsApis.getLinkedInAdsCredentials also throws this for a connected row with no access_token.
    'LinkedIn Ads account not connected. Please connect your LinkedIn Ads account in settings.',
    // clickup/foreplay getAccessToken return null for a stored token that fails to decrypt.
    'ClickUp not connected',
    'Foreplay not connected',
    'Account abc is not connected to your profile. Connect a LinkedIn Outreach account in Settings to use this action.',
    'HubSpot account "42" not found. Please reconnect your account.',
  ])('keeps "%s" dispatchable', async (msg) => {
    expect(isNeverConnectedMessage(msg)).toBe(false);
    const out = await rs.evaluate([...invoked('t', 7), ...fail('t', 5, msg)], WINDOW);
    expect(out).toHaveLength(1);
    expect((out[0].payload as any).failureType).toBe('config');
  });
});

// ENG-3152/3154: post-merge verification probes run as a dedicated account and, by design, trip every new guard.
// Their runs must not count toward (or against) a customer-facing cluster.
describe('AgentFailureRuleSet: synthetic (verifier) traffic', () => {
  const QA = 'qa-user-id';
  const run = (runId: string, userId: string): NormalizedEvent => ({
    subjectId: asSubjectId(runId),
    eventType: EVT_RUN_STARTED,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { userId },
  });
  const toolEvt = (runId: string, eventType: string, toolName: string, extra: Record<string, string> = {}): NormalizedEvent => ({
    subjectId: asSubjectId(runId),
    eventType,
    ts: new Date('2026-06-04T00:00:00Z'),
    dimensions: { toolName, ...extra },
  });
  const probeEvents = () => [
    run('run-qa', QA),
    ...Array.from({ length: 9 }, () => toolEvt('run-qa', EVT_TOOL_INVOKED, 'probe_tool')),
    ...Array.from({ length: 9 }, () => toolEvt('run-qa', EVT_TOOL_FAILED, 'probe_tool', { errorClass: 'Error', failureType: 'bug', errorMessage: 'boom' })),
  ];

  it('files the cluster when the verifier account is not configured (default behaviour unchanged)', async () => {
    const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });
    expect((await policy.evaluate(probeEvents(), WINDOW)).length).toBe(1);
  });

  it('drops a cluster made only of the configured verifier account\'s runs', async () => {
    const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2, syntheticUserIds: [QA] });
    expect(await policy.evaluate(probeEvents(), WINDOW)).toEqual([]);
  });

  it('removes verifier runs from both failures and the denominator, keeping the customers\' own cluster', async () => {
    const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2, syntheticUserIds: [QA] });
    const customer = [
      run('run-c', 'customer-1'),
      ...Array.from({ length: 10 }, () => toolEvt('run-c', EVT_TOOL_INVOKED, 'probe_tool')),
      ...Array.from({ length: 4 }, () => toolEvt('run-c', EVT_TOOL_FAILED, 'probe_tool', { errorClass: 'Error', failureType: 'bug', errorMessage: 'boom' })),
    ];
    const proposals = await policy.evaluate([...probeEvents(), ...customer], WINDOW);
    expect(proposals).toHaveLength(1);
    const stats = (proposals[0] as any).triggeringStats;
    expect(stats.failures).toBe(4);
    expect(stats.invocations).toBe(10);
  });

  it('works when the run_started event arrives after the tool events', async () => {
    const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2, syntheticUserIds: [QA] });
    const [started, ...rest] = probeEvents();
    expect(await policy.evaluate([...rest, started], WINDOW)).toEqual([]);
  });

  it('reads the account list from AGENT_LOOP_SYNTHETIC_USER_IDS (comma separated, trimmed)', async () => {
    process.env.AGENT_LOOP_SYNTHETIC_USER_IDS = ` other-id , ${QA} `;
    try {
      const policy = new AgentFailureRuleSet({ minFailures: 3, minFailureRate: 0.2 });
      expect(await policy.evaluate(probeEvents(), WINDOW)).toEqual([]);
    } finally {
      delete process.env.AGENT_LOOP_SYNTHETIC_USER_IDS;
    }
  });
});
