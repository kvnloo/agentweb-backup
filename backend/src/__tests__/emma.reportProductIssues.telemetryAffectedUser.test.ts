/**
 * ENG-939: telemetry/satisfaction-report filings must attach the SESSION OWNER as the affected
 * reporter, not whoever is chatting when the report gets filed. `report_product_issues`'
 * `run_id` dossier enrichment already resolves the analysed run (AgentRunSummary.userId); this
 * wires that id to the reporter fields instead of defaulting to the calling user's own identity.
 *
 * Concrete failure this fixes (ENG-829): an internal reviewer (Rui) reviewed a daily satisfaction
 * report, found a real bug in a CUSTOMER's session (Ed), and filed it via report_product_issues
 * with a run_id pointing at Ed's run. The filed issue credited Rui as the reporter, so the
 * ENG-170 "your bug shipped" notification addressed Rui — an internal account — instead of Ed,
 * the customer who actually hit the bug.
 */

jest.mock('../services/intakeService', () => ({
  fileUserIssue: jest.fn(async () => ({
    pageId: '7',
    trackerUrl: 'https://fb/t/7',
    userUrl: 'https://fb/t/7',
    canonicalUrl: 'https://linear.app/emmabyaw/issue/ENG-1',
    deduped: false,
    tracker: 'Featurebase',
  })),
}));
jest.mock('../services/resendService', () => ({
  resendService: { sendEmail: jest.fn(async () => ({ id: 'em-1' })) },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getJsonArraySetting: jest.fn(async () => ['founders@agentweb.pro']) },
}));
jest.mock('../services/db', () => {
  const actual = jest.requireActual('../services/db');
  return {
    ...actual,
    userDb: { getUserById: jest.fn() },
  };
});
jest.mock('../services/agentRunInspectorService', () => {
  const actual = jest.requireActual('../services/agentRunInspectorService');
  return { ...actual, fetchAgentRunSummaries: jest.fn() };
});

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { fileUserIssue } from '../services/intakeService';
import { fetchAgentRunSummaries } from '../services/agentRunInspectorService';
import { userDb } from '../services/db';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;
const lastFileCall = () => (fileUserIssue as jest.Mock).mock.calls.at(-1)![0];

const REVIEWER = { userId: 'reviewer-1', email: 'rui@agentweb.pro', displayName: 'Rui', isAdmin: true };
const CUSTOMER = { userId: 'customer-1', email: 'ed@xcures.com', displayName: 'Ed', funnelStatus: 'paid_retention_handoff' };

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
    if (id === REVIEWER.userId) return REVIEWER;
    if (id === CUSTOMER.userId) return CUSTOMER;
    return undefined;
  });
});

describe('report_product_issues — telemetry-affected-user attribution (ENG-939)', () => {
  const issueWithRun = (runId: string) => ({ title: 'GA4 conclusions wrong', description: 'Asserted unverified UTM data', run_id: runId });

  it('run_id belongs to a DIFFERENT user than the caller -> attaches that user as the reporter, not the caller', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{ runId: 'run-1', sessionId: 'sess-ed-1', userId: CUSTOMER.userId, verdict: 'degraded', toolCalls: 4, failedToolCalls: 1, outcomes: [] }],
      scannedEvents: 10,
      truncated: false,
    });

    await tool().execute({ issues: [issueWithRun('run-1')] }, { userId: REVIEWER.userId });

    const call = lastFileCall();
    expect(call.userEmail).toBe('ed@xcures.com');
    expect(call.userName).toBe('Ed');
    // The surfacing reviewer is recorded distinctly — never overwritten, never dropped.
    expect(call.reportedByAdmin).toBe('rui@agentweb.pro');
    expect(call.noResolvableReporter).toBeFalsy();
  });

  it('carries the affected user\'s own session id and funnel status, not the reviewer\'s', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{ runId: 'run-1', sessionId: 'sess-ed-1', userId: CUSTOMER.userId, verdict: 'degraded', toolCalls: 1, failedToolCalls: 1, outcomes: [] }],
      scannedEvents: 1,
      truncated: false,
    });

    await tool().execute({ issues: [issueWithRun('run-1')] }, { userId: REVIEWER.userId, sessionId: 'rui-review-session' });

    const call = lastFileCall();
    expect(call.sessionId).toBe('sess-ed-1');
    expect(call.funnelStatus).toBe('paid_retention_handoff');
  });

  it('run_id belongs to the CALLER\'s own session -> unchanged self-report behavior', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{ runId: 'run-2', sessionId: 'rui-own-session', userId: REVIEWER.userId, verdict: 'ok', toolCalls: 1, failedToolCalls: 0, outcomes: [] }],
      scannedEvents: 1,
      truncated: false,
    });

    await tool().execute({ issues: [issueWithRun('run-2')] }, { userId: REVIEWER.userId });

    const call = lastFileCall();
    expect(call.userEmail).toBe('rui@agentweb.pro');
    expect(call.reportedByAdmin).toBeUndefined();
    expect(call.noResolvableReporter).toBeFalsy();
  });

  it('no run_id at all -> unchanged self-report behavior', async () => {
    await tool().execute({ issues: [{ title: 'My own bug', description: 'It broke on me' }] }, { userId: REVIEWER.userId });

    const call = lastFileCall();
    expect(call.userEmail).toBe('rui@agentweb.pro');
    expect(call.reportedByAdmin).toBeUndefined();
    expect(call.noResolvableReporter).toBeFalsy();
  });

  it('run_id points at another user, but that user cannot be resolved -> files with noResolvableReporter, preserves the run session + surfacing reviewer, never defaults to the reviewer as the affected user', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{ runId: 'run-3', sessionId: 'sess-ghost', userId: 'deleted-user-99', verdict: 'failed', toolCalls: 1, failedToolCalls: 1, outcomes: [] }],
      scannedEvents: 1,
      truncated: false,
    });

    const result = await tool().execute({ issues: [issueWithRun('run-3')] }, { userId: REVIEWER.userId, sessionId: 'rui-review-session' });

    const call = lastFileCall();
    expect(call.noResolvableReporter).toBe(true);
    // The analysed run's OWN session is preserved for eng traceability — never silently
    // replaced by the reviewer's own chat session just because the owner didn't resolve.
    expect(call.sessionId).toBe('sess-ghost');
    // The surfacing reviewer is still recorded, even though the affected user isn't.
    expect(call.reportedByAdmin).toBe('rui@agentweb.pro');
    // notionContext must not silently present the REVIEWER as the affected user — that would
    // make the auto-generated Linear description read as an ordinary self-report.
    expect(call.notionContext['User Email']).not.toBe('rui@agentweb.pro');
    expect(call.notionContext['Surfaced By']).toBe('rui@agentweb.pro');
    // Still files — report_product_issues does not fail the report over an unresolved affected user.
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('"success":false');
  });

  it('affected-user lookup throwing (DB error) degrades to noResolvableReporter, preserves the run session + surfacing reviewer, never crashes the report', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{ runId: 'run-4', sessionId: 'sess-x', userId: 'some-other-user', verdict: 'failed', toolCalls: 1, failedToolCalls: 1, outcomes: [] }],
      scannedEvents: 1,
      truncated: false,
    });
    (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) => {
      if (id === REVIEWER.userId) return REVIEWER;
      throw new Error('dynamo down');
    });

    const result = await tool().execute({ issues: [issueWithRun('run-4')] }, { userId: REVIEWER.userId });

    const call = lastFileCall();
    expect(call.noResolvableReporter).toBe(true);
    expect(call.sessionId).toBe('sess-x');
    expect(call.reportedByAdmin).toBe('rui@agentweb.pro');
    expect(call.notionContext['User Email']).not.toBe('rui@agentweb.pro');
    expect(JSON.stringify(result)).not.toContain('"success":false');
  });
});
