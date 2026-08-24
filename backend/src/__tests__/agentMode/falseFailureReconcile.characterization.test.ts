/**
 * ENG-971 — false-FAILURE reconciler, pinned through the REAL loop.
 *
 * The unit tests in falseFailureReport.test.ts cover the pure guard and
 * agentModeService.bookkeepingToolError.test.ts covers the criticality verdict fed
 * back to the model. Neither proves the guard actually runs at the loop edge — which
 * is exactly where the bug lived: publish_landing_page_changes succeeded and was
 * verified live, save_memory then failed schema validation, and the FINAL message
 * told the user "the system timed out and your changes were not saved. Please try
 * again" — inviting a re-run of a production deploy that had already landed.
 *
 * This characterization drives the REAL loop (scripted LLM turns + mocked leaf tool
 * execution; dispatch, extractMinimalToolResult, message-appending and the reconciler
 * all run for real) and pins the OBSERVABLE outcome: the confirmed publish is stated
 * back to the user, a GENUINE failure is left untouched (no fabricated success), and
 * a truthful closing message is never decorated.
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

// The bug's signature: a trailing bookkeeping failure generalized into a
// session-level "timed out / not saved / try again".
const FALSE_FAILURE_MESSAGE =
  'It looks like the system timed out and your changes were not saved. Please try again.';

const PUBLISH_SUCCESS_RESULT = {
  result: { content: JSON.stringify({ success: true, message: 'Changes published to production' }) },
};
const SAVE_MEMORY_SCHEMA_REJECT = {
  error: 'save_memory arguments failed schema validation: "memory_content" is required',
};

const PUBLISH_ARGS = JSON.stringify({ page_id: 'page-123' });
const MEMORY_ARGS = JSON.stringify({ title: 'Capture route fix' });

describe('ENG-971 false-failure reconcile — through the real generateMarketingResponse loop', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('corrects a false "timed out / not saved" close after a confirmed publish', async () => {
    const snapshot = await runScenario(service, {
      message: 'Fix the lead-capture route on the healthcare lander and publish it.',
      transcript: [
        { tool_calls: [{ id: 'p1', name: 'publish_landing_page_changes', arguments: PUBLISH_ARGS }] },
        { tool_calls: [{ id: 'm1', name: 'save_memory', arguments: MEMORY_ARGS }] },
        { content: FALSE_FAILURE_MESSAGE },
      ],
      toolResults: {
        publish_landing_page_changes: PUBLISH_SUCCESS_RESULT,
        save_memory: SAVE_MEMORY_SCHEMA_REJECT,
      },
    });

    // The true outcome is stated back to the user...
    expect(snapshot.content).toContain('published your landing-page changes');
    expect(snapshot.content).toMatch(/do NOT re-run/i);
    expect(snapshot.content).toMatch(/bookkeeping/i);
    // ...by APPENDING to the model's own text, never rewriting it.
    expect(snapshot.content.startsWith(FALSE_FAILURE_MESSAGE)).toBe(true);
    expect(snapshot.cancelled).toBe(false);
  });

  it('leaves a GENUINE publish failure untouched — no fabricated success line', async () => {
    const snapshot = await runScenario(service, {
      message: 'Fix the lead-capture route on the healthcare lander and publish it.',
      transcript: [
        { tool_calls: [{ id: 'p1', name: 'publish_landing_page_changes', arguments: PUBLISH_ARGS }] },
        { content: FALSE_FAILURE_MESSAGE },
      ],
      toolResults: {
        publish_landing_page_changes: { error: 'Upstream returned 502 Bad Gateway' },
      },
    });

    expect(snapshot.content).toBe(FALSE_FAILURE_MESSAGE);
    expect(snapshot.content).not.toMatch(/Correction/i);
  });

  it('leaves a truthful closing message untouched', async () => {
    const truthful =
      'Your landing-page changes are published to production and I verified the capture route live. '
      + 'One note: I could not save a memory note for future sessions.';
    const snapshot = await runScenario(service, {
      message: 'Fix the lead-capture route on the healthcare lander and publish it.',
      transcript: [
        { tool_calls: [{ id: 'p1', name: 'publish_landing_page_changes', arguments: PUBLISH_ARGS }] },
        { tool_calls: [{ id: 'm1', name: 'save_memory', arguments: MEMORY_ARGS }] },
        { content: truthful },
      ],
      toolResults: {
        publish_landing_page_changes: PUBLISH_SUCCESS_RESULT,
        save_memory: SAVE_MEMORY_SCHEMA_REJECT,
      },
    });

    expect(snapshot.content).toBe(truthful);
  });
});
