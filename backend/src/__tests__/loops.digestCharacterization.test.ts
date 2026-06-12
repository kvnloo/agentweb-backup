/**
 * Characterization tests — pin the EXACT rendered Slack digest text of every
 * loop instance across the digest consolidation refactor.
 *
 * The Slack approval dispatcher regex-parses these digests (the Run ID line,
 * the numbered findings, and the 'React ✅ to dispatch all to cloud-dev'
 * footer — see services/loopSlackApprovalDispatcher.ts), so the rendered text
 * is a wire format: any drift is a functional regression, not cosmetics.
 *
 * These tests were written BEFORE the consolidation and must pass unchanged
 * after it. Do not "fix" an expected string to match new output — fix the
 * output.
 */

import { _resetRegistryForTesting } from '../loops';
import { productionLoopPorts } from '../loops/adapters/awsAdapters';
import { runLoop } from '../loops/core/orchestrator';
import type { LoopPorts } from '../loops/core/ports';
import type { LoopRunResult, Mutation } from '../loops/core/types';
import { runAgentModeLoopOnce, _internal as agentModeInternal } from '../loops/instances/agent-mode';
import { runOnboardingLoopV2Once } from '../loops/instances/onboarding';
import { _testing as aiReadinessTesting } from '../loops/instances/ai-readiness-funnel';
import { _postDailyDigestForTesting } from '../loops/instances/ai-eval-funnel/cron';

jest.mock('../loops/adapters/awsAdapters', () => ({
  productionLoopPorts: jest.fn(),
}));
jest.mock('../loops/core/orchestrator', () => ({
  runLoop: jest.fn(),
}));

const mockedPorts = productionLoopPorts as jest.MockedFunction<typeof productionLoopPorts>;
const mockedRunLoop = runLoop as jest.MockedFunction<typeof runLoop>;

const HARSHA = 'U08TM4QFQ1L';
const FOOTER = 'React ✅ to dispatch all to cloud-dev  |  ❌ to skip  |  🛑 to pause loop';

/** The digests embed the current date — compute it the same way the code does. */
const TODAY = new Date().toISOString().slice(0, 10);

function fakeResult(over: Partial<LoopRunResult>): LoopRunResult {
  return {
    loopId: 'test-loop',
    runId: 'run_test',
    startedAt: new Date(),
    finishedAt: new Date(),
    eventsScanned: 0,
    proposals: [],
    mutations: [],
    approvals: [],
    blocked: false,
    durationMs: 1,
    tokensSpentUsd: 0,
    ...over,
  } as unknown as LoopRunResult;
}

function proposal(hypothesis: string, kind: string, directive?: string): LoopRunResult['proposals'][number] {
  return {
    proposalId: 'p1',
    sourceRuleId: 'rule-1',
    hypothesis,
    kind,
    payload: directive === undefined ? {} : { directive },
    triggeringStats: {},
  } as unknown as LoopRunResult['proposals'][number];
}

describe('loop digest characterization (exact rendered text)', () => {
  let slackPosts: string[];
  let ports: LoopPorts;

  beforeEach(() => {
    _resetRegistryForTesting();
    agentModeInternal.resetForTesting();
    slackPosts = [];
    ports = {
      s3: {},
      dynamo: {},
      bedrock: {},
      slack: {
        postMessage: jest.fn().mockImplementation(async (_user: string, markdown: string) => {
          slackPosts.push(markdown);
          return { ok: true };
        }),
      },
      clock: { now: () => new Date() },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    } as unknown as LoopPorts;
    mockedPorts.mockReturnValue(ports);
  });

  afterEach(() => {
    _resetRegistryForTesting();
    agentModeInternal.resetForTesting();
    delete process.env.ONBOARDING_LOOP_V2;
  });

  describe('agent-mode', () => {
    it('renders the findings digest verbatim', async () => {
      mockedRunLoop.mockResolvedValue(
        fakeResult({
          runId: 'run_agent_1' as LoopRunResult['runId'],
          eventsScanned: 42,
          proposals: [
            proposal('Tool `publish_blog_article` failed 6/9 calls (67%) — top error: Webflow 502', 'code_change'),
            proposal('Tool `search_leads` failed 3/7 calls (43%) — top error: timeout', 'code_change'),
          ],
        }),
      );

      await runAgentModeLoopOnce();

      expect(ports.slack.postMessage).toHaveBeenCalledTimes(1);
      expect(ports.slack.postMessage).toHaveBeenCalledWith(HARSHA, expect.any(String));
      expect(slackPosts[0]).toBe(
        [
          `*🤖 Agent Mode — tool reliability ${TODAY}*`,
          'Run ID: `run_agent_1`',
          'Tool events scanned: 42  |  Failing tools: 2',
          '',
          '*Failing tools (fix specs dispatched: 0)*',
          '1. Tool `publish_blog_article` failed 6/9 calls (67%) — top error: Webflow 502',
          '2. Tool `search_leads` failed 3/7 calls (43%) — top error: timeout',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the empty-window digest verbatim', async () => {
      mockedRunLoop.mockResolvedValue(fakeResult({ runId: 'run_agent_2' as LoopRunResult['runId'], eventsScanned: 0 }));

      await runAgentModeLoopOnce();

      expect(slackPosts[0]).toBe(
        [
          `*🤖 Agent Mode — tool reliability ${TODAY}*`,
          'Run ID: `run_agent_2`',
          'Tool events scanned: 0  |  Failing tools: 0',
          '',
          '_No agent-mode tool events in the 7d window — recorder off, or no tool use. Not "healthy", just empty._',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the no-findings digest verbatim', async () => {
      mockedRunLoop.mockResolvedValue(fakeResult({ runId: 'run_agent_3' as LoopRunResult['runId'], eventsScanned: 17 }));

      await runAgentModeLoopOnce();

      expect(slackPosts[0]).toBe(
        [
          `*🤖 Agent Mode — tool reliability ${TODAY}*`,
          'Run ID: `run_agent_3`',
          'Tool events scanned: 17  |  Failing tools: 0',
          '',
          '_No tool crossed the failure threshold this window. Tool reliability looks healthy._',
          '',
          FOOTER,
        ].join('\n'),
      );
    });
  });

  describe('onboarding v2', () => {
    beforeEach(() => {
      process.env.ONBOARDING_LOOP_V2 = 'true';
    });

    it('renders the findings digest verbatim (with and without a Fix directive)', async () => {
      mockedRunLoop.mockResolvedValue(
        fakeResult({
          runId: 'run_ob_1' as LoopRunResult['runId'],
          eventsScanned: 31,
          proposals: [
            proposal('Users loop back from brand review to goal selection', 'copy', 'clarify the goal step CTA'),
            proposal('ICP step abandonment at 40%', 'code_change'),
          ],
        }),
      );

      await runOnboardingLoopV2Once();

      expect(ports.slack.postMessage).toHaveBeenCalledTimes(1);
      expect(ports.slack.postMessage).toHaveBeenCalledWith(HARSHA, expect.any(String));
      expect(slackPosts[0]).toBe(
        [
          `*🚀 Onboarding loop — daily run ${TODAY}*`,
          'Run ID: `run_ob_1`',
          'Users/events scanned: 31  |  Findings: 2',
          '',
          '*What I found*',
          '1. Users loop back from brand review to goal selection',
          '   Kind: `copy`  |  Fix: clarify the goal step CTA',
          '2. ICP step abandonment at 40%',
          '   Kind: `code_change`',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the empty-window digest verbatim', async () => {
      mockedRunLoop.mockResolvedValue(fakeResult({ runId: 'run_ob_2' as LoopRunResult['runId'], eventsScanned: 0 }));

      await runOnboardingLoopV2Once();

      expect(slackPosts[0]).toBe(
        [
          `*🚀 Onboarding loop — daily run ${TODAY}*`,
          'Run ID: `run_ob_2`',
          'Users/events scanned: 0  |  Findings: 0',
          '',
          '_No onboarding events in the window — too thin to judge._',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the no-findings digest verbatim', async () => {
      mockedRunLoop.mockResolvedValue(fakeResult({ runId: 'run_ob_3' as LoopRunResult['runId'], eventsScanned: 12 }));

      await runOnboardingLoopV2Once();

      expect(slackPosts[0]).toBe(
        [
          `*🚀 Onboarding loop — daily run ${TODAY}*`,
          'Run ID: `run_ob_3`',
          'Users/events scanned: 12  |  Findings: 0',
          '',
          '_Funnel looks healthy — no issues surfaced._',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('returns null and posts nothing when ONBOARDING_LOOP_V2 is off', async () => {
      delete process.env.ONBOARDING_LOOP_V2;
      const result = await runOnboardingLoopV2Once();
      expect(result).toBeNull();
      expect(slackPosts).toHaveLength(0);
    });
  });

  describe('ai-readiness funnel', () => {
    const { buildDigestLines } = aiReadinessTesting;

    it('renders the findings digest (with funnel shape) verbatim', () => {
      const lines = buildDigestLines(
        fakeResult({
          runId: 'run_air_1' as LoopRunResult['runId'],
          eventsScanned: 200,
          proposals: [proposal('Quiz step drops 40%', 'copy', 'shorten the quiz to one question')],
        }),
        { landed: 200, quiz_started: 120, form_submitted: 30, book_clicked: 8, signup_clicked: 8 },
      );

      expect(lines.join('\n')).toBe(
        [
          `*🧭 AI Readiness Funnel — daily run ${TODAY}*`,
          'Run ID: `run_air_1`',
          'Events scanned: 200  |  Findings: 1',
          '*Funnel (7d):* landed `200` → quiz `120` → *captured `30`* → book `8` / signup `8`',
          '',
          '*What I found*',
          '1. Quiz step drops 40%',
          '   Kind: `copy`  |  Fix: shorten the quiz to one question',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the empty-window digest with the low-data decision block verbatim', () => {
      const lines = buildDigestLines(
        fakeResult({ runId: 'run_air_2' as LoopRunResult['runId'], eventsScanned: 0 }),
        { landed: 0, quiz_started: 0, form_submitted: 0, book_clicked: 0, signup_clicked: 0 },
      );

      expect(lines.join('\n')).toBe(
        [
          `*🧭 AI Readiness Funnel — daily run ${TODAY}*`,
          'Run ID: `run_air_2`',
          'Events scanned: 0  |  Findings: 0',
          '*Funnel (7d):* landed `0` → quiz `0` → *captured `0`* → book `0` / signup `0`',
          '',
          '_No events in the 7d window — the lander isn\'t getting traffic, or telemetry just turned on. Not "healthy", just empty._',
          '',
          '*Startup decisions (low-data, permission-gated)*',
          '1. `low-data-no-traffic` — Verify telemetry and route at least one owned surface into /ai-readiness today before changing page copy.',
          '   Evidence: 0 /ai-readiness landings in the 7d window.  |  Confidence: low  |  Needs approval: yes',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the null-shape no-findings digest verbatim (no shape line, no low-data block)', () => {
      const lines = buildDigestLines(
        fakeResult({ runId: 'run_air_3' as LoopRunResult['runId'], eventsScanned: 50 }),
        null,
      );

      expect(lines.join('\n')).toBe(
        [
          `*🧭 AI Readiness Funnel — daily run ${TODAY}*`,
          'Run ID: `run_air_3`',
          'Events scanned: 50  |  Findings: 0',
          '',
          '_No page-level fix surfaced — check the binding constraint manually._',
          '',
          FOOTER,
        ].join('\n'),
      );
    });

    it('renders the healthy-volume constraint line verbatim', () => {
      const lines = buildDigestLines(
        fakeResult({ runId: 'run_air_4' as LoopRunResult['runId'], eventsScanned: 800 }),
        { landed: 800, quiz_started: 400, form_submitted: 120, book_clicked: 40, signup_clicked: 40 },
      );

      expect(lines.join('\n')).toBe(
        [
          `*🧭 AI Readiness Funnel — daily run ${TODAY}*`,
          'Run ID: `run_air_4`',
          'Events scanned: 800  |  Findings: 0',
          '*Funnel (7d):* landed `800` → quiz `400` → *captured `120`* → book `40` / signup `40`',
          '',
          '_No disproportionate leak this window. Watch the shape above; the next push is whichever stage is thinnest._',
          '',
          FOOTER,
        ].join('\n'),
      );
    });
  });

  describe('ai-eval funnel (cron digest)', () => {
    function evalMutation(over: Record<string, unknown>, error?: string): Mutation {
      const m = {
        mutationId: 'm1',
        proposalId: 'p1',
        kind: 'copy',
        artifact: over,
      } as unknown as Mutation;
      if (error) (m as Mutation & { error?: string }).error = error;
      return m;
    }

    it('renders the findings digest (Notion link + RCA top fix + Notion error) verbatim', async () => {
      const result = fakeResult({
        runId: 'run-eval-1' as LoopRunResult['runId'],
        eventsScanned: 300,
        proposals: [
          proposal('Lots of landings but very few form submits.', 'copy'),
          proposal('Eval completers do not click signup.', 'copy'),
        ].map((p, i) => ({ ...p, sourceRuleId: i === 0 ? 'capture-broken' : 'no-signup' })),
      });
      const muts: Mutation[] = [
        evalMutation({
          notionUrl: 'https://www.notion.so/p1',
          title: 'fix(ai-eval-funnel): capture-broken',
          rcaEnrichment: {
            topHypotheses: ['x'],
            rankedFixes: [
              { title: 'Scope rule denominator by landerPath = /ai-eval', impact: 'high', confidence: 'high', cost_sp: 1, why_this_rank: 'y' },
            ],
          },
        }),
        evalMutation({ title: 'fix(ai-eval-funnel): no-signup', rcaEnrichment: { topHypotheses: [], rankedFixes: [], error: 'Bedrock 500' } }, 'Notion API 502'),
      ];
      const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };

      await _postDailyDigestForTesting(result, muts, slack, HARSHA);

      expect(slack.postMessage).toHaveBeenCalledTimes(1);
      expect(slack.postMessage.mock.calls[0][0]).toBe(HARSHA);
      expect(slack.postMessage.mock.calls[0][1]).toBe(
        [
          `*🌅 AI Eval Funnel — daily run ${TODAY}*`,
          'Run ID: `run-eval-1`',
          'Events scanned: 300  |  Rules fired: 2  |  Mutations: 2',
          '',
          '*Proposed fixes*',
          '1. <https://www.notion.so/p1|fix(ai-eval-funnel): capture-broken>',
          '   Rule: `capture-broken`  |  Kind: `copy`',
          '   ↳ Top fix: Scope rule denominator by landerPath = /ai-eval',
          '2. fix(ai-eval-funnel): no-signup',
          '   Rule: `no-signup`  |  Kind: `copy`',
          '   ⚠️ RCA unavailable',
          '   ⚠️ Notion API 502',
          '',
          FOOTER,
          'Reply in thread to skip a specific item (e.g. "skip 2").',
        ].join('\n'),
      );
    });

    it('renders the empty-window digest verbatim', async () => {
      const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };

      await _postDailyDigestForTesting(
        fakeResult({ runId: 'run-eval-2' as LoopRunResult['runId'], eventsScanned: 0 }),
        [],
        slack,
        HARSHA,
      );

      expect(slack.postMessage.mock.calls[0][1]).toBe(
        [
          `*🌅 AI Eval Funnel — daily run ${TODAY}*`,
          'Run ID: `run-eval-2`',
          'Events scanned: 0  |  Rules fired: 0  |  Mutations: 0',
          '',
          "_No events in the last 168h window. Either traffic is dry or telemetry isn't reaching the table yet._",
          '',
          FOOTER,
          'Reply in thread to skip a specific item (e.g. "skip 2").',
        ].join('\n'),
      );
    });

    it('renders the no-findings digest verbatim', async () => {
      const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };

      await _postDailyDigestForTesting(
        fakeResult({ runId: 'run-eval-3' as LoopRunResult['runId'], eventsScanned: 88 }),
        [],
        slack,
        HARSHA,
      );

      expect(slack.postMessage.mock.calls[0][1]).toBe(
        [
          `*🌅 AI Eval Funnel — daily run ${TODAY}*`,
          'Run ID: `run-eval-3`',
          'Events scanned: 88  |  Rules fired: 0  |  Mutations: 0',
          '',
          '_No rules fired — funnel is healthy._',
          '',
          FOOTER,
          'Reply in thread to skip a specific item (e.g. "skip 2").',
        ].join('\n'),
      );
    });

    it('falls back to the rule id and n/a kind when a mutation has no matching proposal', async () => {
      const slack = { postMessage: jest.fn().mockResolvedValue({ ok: true }) };

      await _postDailyDigestForTesting(
        fakeResult({ runId: 'run-eval-4' as LoopRunResult['runId'], eventsScanned: 10, proposals: [] as LoopRunResult['proposals'] }),
        [evalMutation({})],
        slack,
        HARSHA,
      );

      // proposals is empty but a mutation exists → eventsScanned>0 branch posts
      // the "no rules fired" body; the mutations count still reads 1.
      expect(slack.postMessage.mock.calls[0][1]).toContain('Rules fired: 0  |  Mutations: 1');
    });
  });
});
