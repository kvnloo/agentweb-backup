/**
 * ENG-736 — landing-page truthful-reporting reconciler, pinned through the REAL loop.
 *
 * The unit tests in landingDeploymentReport.test.ts and
 * agentModeService.extractMinimalToolResult.test.ts each cover ONE HALF of the fix
 * in isolation (the pure reconciler; the ledger-preservation branch). Neither proves
 * the two halves compose correctly inside `generateMarketingResponse` — which is
 * exactly where the bug lived: a get_deployment_status success + live URL landed in
 * the tool ledger, yet the final message reported "the deployment timed out" and
 * withheld the URL.
 *
 * This characterization drives the REAL loop (scripted LLM turns + mocked leaf tool
 * execution; dispatch, extractMinimalToolResult, message-appending and the reconciler
 * all run for real) and pins the OBSERVABLE outcome: the live URL is surfaced to the
 * user even when the model falsely narrates a timeout, a GENUINE failure is left
 * untouched (no fabricated success), and an already-present URL is not duplicated.
 */

import { AgentModeService } from '../../services/agentModeService';
import { runScenario, installStandardMockDeps } from './characterization/harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../services/settingsService');
jest.mock('../../services/db');
jest.mock('../../services/chatbotService');
jest.mock('../../utils/secretsManager');
jest.mock('../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const DEPLOYED_URL = 'https://cold-outreach-pilot.agentwebforms.com';

// The exact ENG-736 shape: the first generate attempt returns a TRANSIENT v0 timeout
// (status 'failed'), then get_deployment_status confirms the build actually went live.
const GENERATE_TIMEOUT_RESULT = {
  result: {
    content: JSON.stringify({
      id: 'page-123',
      status: 'failed',
      buildError: 'V0_CALL_TIMEOUT: generation timed out on the first attempt',
    }),
  },
};
const DEPLOY_SUCCESS_RESULT = {
  result: {
    content: JSON.stringify({
      status: 'deployed',
      buildStatus: 'success',
      deployedUrl: DEPLOYED_URL,
      name: 'Cold Outreach Pilot',
    }),
  },
};

// The bug's signature: the model fixates on the earlier transient timeout and reports
// failure, withholding the URL it had already produced.
const FALSE_TIMEOUT_MESSAGE =
  "I'm sorry — the landing-page deployment step timed out, so I wasn't able to finish. Please try again in a bit.";

const GENERATE_ARGS = JSON.stringify({ prompt: 'Cold outreach pilot landing page', lead_list_id: 'list-9' });
const STATUS_ARGS = JSON.stringify({ page_id: 'page-123' });

describe('ENG-736 landing deployment reconcile — through the real generateMarketingResponse loop', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('surfaces the successfully-deployed URL the false "timed out" final message withheld', async () => {
    const snapshot = await runScenario(service, {
      message: 'Build a landing page for a cold-outreach pilot.',
      transcript: [
        { tool_calls: [{ id: 'g1', name: 'generate_landing_page', arguments: GENERATE_ARGS }] },
        { tool_calls: [{ id: 'd1', name: 'get_deployment_status', arguments: STATUS_ARGS }] },
        { content: FALSE_TIMEOUT_MESSAGE },
      ],
      toolResults: {
        generate_landing_page: GENERATE_TIMEOUT_RESULT,
        get_deployment_status: DEPLOY_SUCCESS_RESULT,
      },
    });

    // The URL that was live in-session but withheld is now surfaced to the user...
    expect(snapshot.content).toContain(DEPLOYED_URL);
    // ...by APPENDING to the model's own text, never rewriting it (so the guard cannot
    // manufacture a false success — it only ever adds a true deliverable).
    expect(snapshot.content.startsWith(FALSE_TIMEOUT_MESSAGE)).toBe(true);
    expect(snapshot.cancelled).toBe(false);
  });

  it('leaves a GENUINE deployment failure untouched — no fabricated success line', async () => {
    const trueFailureMessage =
      'The landing-page build failed to deploy (Vercel returned an error). Nothing went live — ask me to retry.';
    const snapshot = await runScenario(service, {
      message: 'Build a landing page for a cold-outreach pilot.',
      transcript: [
        { tool_calls: [{ id: 'd1', name: 'get_deployment_status', arguments: STATUS_ARGS }] },
        { content: trueFailureMessage },
      ],
      toolResults: {
        // buildStatus 'error' with no deployedUrl — a real failure the reconciler must
        // NOT touch (there is no live URL to surface).
        get_deployment_status: {
          result: { content: JSON.stringify({ status: 'failed', buildStatus: 'error', buildError: 'Build failed' }) },
        },
      },
    });

    expect(snapshot.content).toBe(trueFailureMessage);
    expect(snapshot.content).not.toContain('deployed successfully');
  });

  it('does not duplicate a URL the final message already includes (markdown link)', async () => {
    const alreadyPresent = `Your landing page is live: [Cold Outreach Pilot](${DEPLOYED_URL}) — go take a look!`;
    const snapshot = await runScenario(service, {
      message: 'Build a landing page for a cold-outreach pilot.',
      transcript: [
        { tool_calls: [{ id: 'd1', name: 'get_deployment_status', arguments: STATUS_ARGS }] },
        { content: alreadyPresent },
      ],
      toolResults: { get_deployment_status: DEPLOY_SUCCESS_RESULT },
    });

    const occurrences = snapshot.content.split(DEPLOYED_URL).length - 1;
    expect(occurrences).toBe(1);
    expect(snapshot.content).toBe(alreadyPresent);
  });
});
