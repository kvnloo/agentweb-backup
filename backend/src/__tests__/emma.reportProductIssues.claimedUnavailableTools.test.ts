/**
 * ENG-1945 second follow-up. Session ff31ccb7 filed a bug via report_product_issues
 * claiming playwright_browser_navigate/snapshot/evaluate/click were "unavailable"
 * without ever having called any of them — it inferred that from an unrelated
 * playwright_browser_handle_dialog error, then proved itself wrong on the very
 * next real attempt. A prompt-only instruction cannot GUARANTEE this never
 * recurs, so `claimed_unavailable_tools` makes the claim itself verifiable: the
 * server checks it against the run's own EVT_TOOL_INVOKED telemetry (recorded
 * independently of anything the model writes) and refuses to file an unverified
 * claim at all, rather than merely being told not to make one.
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
// The prose-detection catalog scan (ENG-1945 second follow-up) reads published skills'
// toolNames — mock it so no test here makes a real DynamoDB call. Empty by default (no
// implied-claim detection possible); individual prose-detection tests below override it
// with a controlled catalog.
jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn(async () => []) },
}));

import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';
import { fileUserIssue } from '../services/intakeService';
import { fetchAgentRunSummaries } from '../services/agentRunInspectorService';
import { userDb } from '../services/db';
import { skillService } from '../services/skillService';

const tool = () => emmaToolRegistry.getTool('report_product_issues')!;
const lastFileCall = () => (fileUserIssue as jest.Mock).mock.calls.at(-1)![0];

const CALLER = { userId: 'user-1', email: 'john@agentweb.pro', displayName: 'John' };

const outcome = (eventType: string, toolName: string) => ({ eventType, toolName });

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserById as jest.Mock).mockImplementation(async (id: string) =>
    id === CALLER.userId ? CALLER : undefined,
  );
  (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
});

describe('report_product_issues — claimed_unavailable_tools deterministic gate (ENG-1945 follow-up)', () => {
  it('rejects the exact prod-incident shape: claiming a tool is unavailable that this run never invoked at all', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-ff31',
        sessionId: 'sess-ff31',
        userId: CALLER.userId,
        verdict: 'degraded',
        toolCalls: 2,
        failedToolCalls: 0,
        // Only handle_dialog and resize were ever called — navigate never was,
        // matching the real session's shape.
        outcomes: [
          outcome('agent_tool_invoked', 'playwright_browser_handle_dialog'),
          outcome('agent_tool_failed', 'playwright_browser_handle_dialog'),
          outcome('agent_tool_invoked', 'playwright_browser_resize'),
          outcome('agent_tool_succeeded', 'playwright_browser_resize'),
        ],
      }],
      scannedEvents: 4,
      truncated: false,
    });

    const result = await tool().execute({
      issues: [{
        title: 'Browser skill installs but navigation tools remain unavailable',
        description: 'Navigation and extraction tools did not appear after install_skills.',
        run_id: 'run-ff31',
        claimed_unavailable_tools: ['playwright_browser_navigate', 'playwright_browser_snapshot'],
      }],
    }, { userId: CALLER.userId });

    expect(fileUserIssue).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('playwright_browser_navigate');
    expect(result.results[0].error).toContain('playwright_browser_snapshot');
    expect(result.results[0].error).toMatch(/never actually called/);
  });

  it('allows the claim when the named tool genuinely was invoked and failed this run', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-real-fail',
        sessionId: 'sess-1',
        userId: CALLER.userId,
        verdict: 'failed',
        toolCalls: 1,
        failedToolCalls: 1,
        outcomes: [
          outcome('agent_tool_invoked', 'playwright_browser_navigate'),
          outcome('agent_tool_failed', 'playwright_browser_navigate'),
        ],
      }],
      scannedEvents: 2,
      truncated: false,
    });

    const result = await tool().execute({
      issues: [{
        title: 'Navigate genuinely fails',
        description: 'Called navigate, it errored.',
        run_id: 'run-real-fail',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId });

    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ success: true });
  });

  it('a call that only SUCCEEDED still counts as "attempted" — the gate is about having tried it, not about it having failed', async () => {
    // Deliberately unusual but must not throw: claiming unavailability for a tool
    // that actually succeeded is not what this gate checks (that's a quality/
    // truthfulness call for a human, not a "never attempted" fact the server can
    // assert). The gate's only job is refusing an UNVERIFIABLE (never-called) claim.
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-succeeded',
        sessionId: 'sess-1',
        userId: CALLER.userId,
        verdict: 'ok',
        toolCalls: 1,
        failedToolCalls: 0,
        outcomes: [
          outcome('agent_tool_invoked', 'playwright_browser_navigate'),
          outcome('agent_tool_succeeded', 'playwright_browser_navigate'),
        ],
      }],
      scannedEvents: 2,
      truncated: false,
    });

    const result = await tool().execute({
      issues: [{
        title: 'Navigate claimed unavailable despite succeeding',
        description: 'Model claims it is broken.',
        run_id: 'run-succeeded',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId });

    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ success: true });
  });

  it('requires a resolvable run whenever claimed_unavailable_tools is set and neither run_id nor context.currentRunId is available — rejects without ever hitting telemetry', async () => {
    const result = await tool().execute({
      issues: [{
        title: 'Tool unavailable, no run_id',
        description: 'Claiming unavailability with no evidence trail.',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId }); // no currentRunId in context either — e.g. an external MCP call

    expect(fetchAgentRunSummaries).not.toHaveBeenCalled();
    expect(fileUserIssue).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('requires a resolvable run');
  });

  it('falls back to context.currentRunId (the server-supplied current run) when the model omits run_id — the honest same-turn case', async () => {
    // This reproduces the live-prod finding: the model has no way to learn its own
    // agentRuntimeRunId and cannot supply it as run_id, so an HONEST claim about the
    // CURRENT run must still verify via the server-threaded context field, not fail
    // just because the model didn't (couldn't) type the id back.
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-ctx-1',
        sessionId: 'sess-1',
        userId: CALLER.userId,
        verdict: 'failed',
        toolCalls: 1,
        failedToolCalls: 1,
        outcomes: [
          outcome('agent_tool_invoked', 'playwright_browser_navigate'),
          outcome('agent_tool_failed', 'playwright_browser_navigate'),
        ],
      }],
      scannedEvents: 2,
      truncated: false,
    });

    const result = await tool().execute({
      issues: [{
        title: 'Navigate genuinely fails, no run_id supplied',
        description: 'Called it, it errored.',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
        // Deliberately no run_id — the model never has one to give.
      }],
    }, { userId: CALLER.userId, currentRunId: 'run-ctx-1' });

    expect(fetchAgentRunSummaries).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-ctx-1' }));
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ success: true });
  });

  it('rejects a false claim verified via context.currentRunId, same as the explicit-run_id path', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-ctx-2',
        sessionId: 'sess-1',
        userId: CALLER.userId,
        verdict: 'degraded',
        toolCalls: 1,
        failedToolCalls: 0,
        outcomes: [outcome('agent_tool_invoked', 'playwright_browser_handle_dialog')],
      }],
      scannedEvents: 1,
      truncated: false,
    });

    const result = await tool().execute({
      issues: [{
        title: 'False claim via context.currentRunId',
        description: 'Claims navigate is broken.',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId, currentRunId: 'run-ctx-2' });

    expect(fileUserIssue).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toContain('playwright_browser_navigate');
    expect(result.results[0].error).toMatch(/never actually called/);
  });

  it('an explicit run_id argument still takes priority over context.currentRunId (ENG-939 cross-run citing case)', async () => {
    // A reviewer analysing a DIFFERENT, already-completed run must be able to cite it
    // explicitly, even while chatting inside their OWN current (unrelated) run.
    (fetchAgentRunSummaries as jest.Mock).mockImplementation(({ runId }: { runId: string }) => {
      if (runId === 'run-other-explicit') {
        return Promise.resolve({
          runs: [{
            runId: 'run-other-explicit',
            sessionId: 'sess-other',
            userId: CALLER.userId,
            verdict: 'failed',
            toolCalls: 1,
            failedToolCalls: 1,
            outcomes: [
              outcome('agent_tool_invoked', 'playwright_browser_navigate'),
              outcome('agent_tool_failed', 'playwright_browser_navigate'),
            ],
          }],
          scannedEvents: 2,
          truncated: false,
        });
      }
      // The reviewer's OWN current run never touched navigate — proves the explicit
      // id, not the context fallback, is what actually got queried/verified against.
      return Promise.resolve({
        runs: [{ runId: 'run-my-current', sessionId: 'sess-mine', userId: CALLER.userId, verdict: 'ok', toolCalls: 0, failedToolCalls: 0, outcomes: [] }],
        scannedEvents: 0,
        truncated: false,
      });
    });

    const result = await tool().execute({
      issues: [{
        title: 'Citing a different run explicitly',
        description: 'Reviewer citing another session.',
        run_id: 'run-other-explicit',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId, currentRunId: 'run-my-current' });

    expect(fetchAgentRunSummaries).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-other-explicit' }));
    expect(fetchAgentRunSummaries).not.toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-my-current' }));
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ success: true });
  });

  it('rejects when run_id does not resolve to a known run — an unverifiable claim must not silently file', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({ runs: [], scannedEvents: 0, truncated: false });

    const result = await tool().execute({
      issues: [{
        title: 'Bad run_id',
        description: 'Claiming unavailability against a bogus run_id.',
        run_id: 'does-not-exist',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId });

    expect(fileUserIssue).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ success: false });
    expect(result.results[0].error).toMatch(/does not resolve to a known run/);
  });

  it('rejects when the telemetry lookup itself throws — a lookup failure must not fall back to filing an unverified claim', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockRejectedValue(new Error('telemetry store unavailable'));

    const result = await tool().execute({
      issues: [{
        title: 'Telemetry lookup fails',
        description: 'Claiming unavailability while the verification lookup itself errors.',
        run_id: 'run-x',
        claimed_unavailable_tools: ['playwright_browser_navigate'],
      }],
    }, { userId: CALLER.userId });

    expect(fileUserIssue).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({ success: false, error: 'telemetry store unavailable' });
  });

  it('a bug report with NO claimed_unavailable_tools is completely unaffected — existing best-effort behavior preserved', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockRejectedValue(new Error('telemetry store unavailable'));

    const result = await tool().execute({
      issues: [{
        title: 'Ordinary bug, no tool-unavailability claim',
        description: 'The output was garbled.',
        run_id: 'run-x',
      }],
    }, { userId: CALLER.userId });

    // Unchanged pre-existing behavior: a dossier-enrichment failure is best-effort
    // and must never block an ordinary report.
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
    expect(result.results[0]).toMatchObject({ success: true });
  });

  it('attaches ground-truth "tools actually invoked" to the filed description whenever run_id is present, even without a structured claim', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-ground-truth',
        sessionId: 'sess-1',
        userId: CALLER.userId,
        verdict: 'degraded',
        toolCalls: 1,
        failedToolCalls: 0,
        outcomes: [
          outcome('agent_tool_invoked', 'playwright_browser_resize'),
          outcome('agent_tool_succeeded', 'playwright_browser_resize'),
        ],
      }],
      scannedEvents: 2,
      truncated: false,
    });

    // Free-text-only claim (the exact bypass the prompt now warns against) — no
    // claimed_unavailable_tools, so the hard gate never engages, but a human
    // reading the filed report must still be able to see the mismatch.
    await tool().execute({
      issues: [{
        title: 'Navigation tools unavailable',
        description: 'Navigation and extraction tools remained unavailable after install.',
        run_id: 'run-ground-truth',
      }],
    }, { userId: CALLER.userId });

    const call = lastFileCall();
    expect(call.description).toContain('tools actually invoked this run: playwright_browser_resize');
  });

  describe('prose-implied claims — the residual gap (real tool name + unavailability wording, no structured field)', () => {
    beforeEach(() => {
      // A controlled catalog containing the exact tool names from the ff31ccb7 incident,
      // so detection has real identifiers to match against.
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([
        { skillId: 'browser-skill', toolNames: ['playwright_browser_navigate', 'playwright_browser_snapshot'] },
      ]);
    });

    it('reproduces the exact ff31ccb7 shape: a real tool name named in prose alongside unavailability wording, never invoked, no claimed_unavailable_tools field at all', async () => {
      (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
        runs: [{
          runId: 'run-prose',
          sessionId: 'sess-1',
          userId: CALLER.userId,
          verdict: 'degraded',
          toolCalls: 1,
          failedToolCalls: 1,
          // Only handle_dialog was called — navigate never was, matching the real session.
          outcomes: [
            outcome('agent_tool_invoked', 'playwright_browser_handle_dialog'),
            outcome('agent_tool_failed', 'playwright_browser_handle_dialog'),
          ],
        }],
        scannedEvents: 2,
        truncated: false,
      });

      const result = await tool().execute({
        issues: [{
          title: 'Browser skill installs but navigation tools remain unavailable',
          description: 'Catalog lists playwright_browser_navigate, but it did not appear as callable after install.',
          run_id: 'run-prose',
          // Deliberately NOT set — this is the exact bypass the field alone cannot close.
        }],
      }, { userId: CALLER.userId });

      expect(fileUserIssue).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ success: false });
      expect(result.results[0].error).toContain('playwright_browser_navigate');
      expect(result.results[0].error).toMatch(/never actually called/);
    });

    it('requires a resolvable run when the wording alone implies a claim and no current run context exists either, same as the explicit field', async () => {
      const result = await tool().execute({
        issues: [{
          title: 'playwright_browser_navigate is unavailable',
          description: 'It is broken and cannot be used.',
          // No run_id, no claimed_unavailable_tools, no context.currentRunId — wording
          // alone triggers the requirement (e.g. an external MCP call with no live run).
        }],
      }, { userId: CALLER.userId });

      expect(fetchAgentRunSummaries).not.toHaveBeenCalled();
      expect(fileUserIssue).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ success: false });
      expect(result.results[0].error).toContain('requires a resolvable run');
    });

    it('a prose-implied claim also falls back to context.currentRunId when run_id is omitted', async () => {
      (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
        runs: [{
          runId: 'run-ctx-prose',
          sessionId: 'sess-1',
          userId: CALLER.userId,
          verdict: 'degraded',
          toolCalls: 1,
          failedToolCalls: 1,
          outcomes: [
            outcome('agent_tool_invoked', 'playwright_browser_handle_dialog'),
            outcome('agent_tool_failed', 'playwright_browser_handle_dialog'),
          ],
        }],
        scannedEvents: 2,
        truncated: false,
      });

      const result = await tool().execute({
        issues: [{
          title: 'Browser skill installs but navigation tools remain unavailable',
          description: 'playwright_browser_navigate did not appear as callable after install.',
        }],
      }, { userId: CALLER.userId, currentRunId: 'run-ctx-prose' });

      expect(fetchAgentRunSummaries).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-ctx-prose' }));
      expect(fileUserIssue).not.toHaveBeenCalled();
      expect(result.results[0]).toMatchObject({ success: false });
      expect(result.results[0].error).toContain('playwright_browser_navigate');
    });

    it('allows the prose claim through when the named tool genuinely was invoked this run', async () => {
      (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
        runs: [{
          runId: 'run-prose-real',
          sessionId: 'sess-1',
          userId: CALLER.userId,
          verdict: 'failed',
          toolCalls: 1,
          failedToolCalls: 1,
          outcomes: [
            outcome('agent_tool_invoked', 'playwright_browser_navigate'),
            outcome('agent_tool_failed', 'playwright_browser_navigate'),
          ],
        }],
        scannedEvents: 2,
        truncated: false,
      });

      const result = await tool().execute({
        issues: [{
          title: 'playwright_browser_navigate is unavailable',
          description: 'Called it, it errored.',
          run_id: 'run-prose-real',
        }],
      }, { userId: CALLER.userId });

      expect(fileUserIssue).toHaveBeenCalledTimes(1);
      expect(result.results[0]).toMatchObject({ success: true });
    });

    it('does NOT trigger the DynamoDB catalog scan for a report with no unavailability wording at all', async () => {
      await tool().execute({
        issues: [{
          title: 'Garbled output',
          description: 'The generated image had visual artifacts.',
        }],
      }, { userId: CALLER.userId });

      expect(skillService.getPublishedSkills).not.toHaveBeenCalled();
      expect(fileUserIssue).toHaveBeenCalledTimes(1);
    });

    it('unavailability wording with no real tool name present is NOT treated as a claim (ordinary vague complaint)', async () => {
      (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
        runs: [{
          runId: 'run-vague',
          sessionId: 'sess-1',
          userId: CALLER.userId,
          verdict: 'degraded',
          toolCalls: 0,
          failedToolCalls: 0,
          outcomes: [],
        }],
        scannedEvents: 0,
        truncated: false,
      });

      const result = await tool().execute({
        issues: [{
          title: 'Feature seems unavailable',
          description: 'I could not find the export button, it seems unavailable to me.',
          run_id: 'run-vague',
        }],
      }, { userId: CALLER.userId });

      // The catalog IS consulted (wording matched), but no real tool identifier is present
      // in the text, so nothing is treated as an implied claim and the report still files.
      expect(skillService.getPublishedSkills).toHaveBeenCalled();
      expect(fileUserIssue).toHaveBeenCalledTimes(1);
      expect(result.results[0]).toMatchObject({ success: true });
    });

    it('the catalog fetch is memoized across a multi-issue batch, not repeated per issue', async () => {
      (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
        runs: [{
          runId: 'run-batch',
          sessionId: 'sess-1',
          userId: CALLER.userId,
          verdict: 'degraded',
          toolCalls: 1,
          failedToolCalls: 0,
          outcomes: [outcome('agent_tool_invoked', 'playwright_browser_navigate')],
        }],
        scannedEvents: 1,
        truncated: false,
      });

      await tool().execute({
        issues: [
          { title: 'playwright_browser_navigate unavailable check 1', description: 'is broken', run_id: 'run-batch' },
          { title: 'playwright_browser_navigate unavailable check 2', description: 'is broken', run_id: 'run-batch' },
        ],
      }, { userId: CALLER.userId });

      expect(skillService.getPublishedSkills).toHaveBeenCalledTimes(1);
    });
  });

  it('mixed batch: one issue with a bad claim is rejected, a sibling ordinary issue in the same call still files', async () => {
    (fetchAgentRunSummaries as jest.Mock).mockResolvedValue({
      runs: [{
        runId: 'run-mixed',
        sessionId: 'sess-1',
        userId: CALLER.userId,
        verdict: 'degraded',
        toolCalls: 0,
        failedToolCalls: 0,
        outcomes: [],
      }],
      scannedEvents: 0,
      truncated: false,
    });

    const result = await tool().execute({
      issues: [
        {
          title: 'Bad claim',
          description: 'Claims navigate is broken, never called it.',
          run_id: 'run-mixed',
          claimed_unavailable_tools: ['playwright_browser_navigate'],
        },
        {
          title: 'Unrelated feature request',
          description: 'I wish there was a dark mode.',
          type: 'feature_request',
        },
      ],
    }, { userId: CALLER.userId });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ title: 'Bad claim', success: false });
    expect(result.results[1]).toMatchObject({ title: 'Unrelated feature request', success: true });
    expect(fileUserIssue).toHaveBeenCalledTimes(1);
  });
});
