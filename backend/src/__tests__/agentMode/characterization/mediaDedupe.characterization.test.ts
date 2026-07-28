/**
 * ENG-510 loop-level proof for cross-iteration media dedupe.
 *
 * The dispatcher unit tests (core/__tests__/toolDispatch.test.ts) prove the suppression
 * logic GIVEN priorMediaCallKeys. These drive the REAL generateMarketingResponse loop with
 * a scripted LLM that re-emits an identical generate_image in a LATER iteration, proving the
 * main loop actually ACCUMULATES the produced keys across iterations and passes them back to
 * the dispatcher — the wiring the isolated dispatcher tests cannot exercise.
 */

import { AgentModeService } from '../../../services/agentModeService';
import { runScenario, installStandardMockDeps } from './harness';

// Standard agentMode mock block (module-hoisted — must live in the test file).
jest.mock('openai');
jest.mock('../../../services/settingsService');
jest.mock('../../../services/db');
jest.mock('../../../services/chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

const imageGenExecCount = (service: AgentModeService): number =>
  ((service as any).executeTool as jest.Mock).mock.calls.filter(
    (c: any[]) => c[1] === 'generate_image',
  ).length;

describe('AgentMode core loop — cross-iteration media dedupe (ENG-510)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('suppresses an identical generate_image re-emitted in a later iteration', async () => {
    const sun = JSON.stringify({ prompt: 'a flat-vector sun', filename: 'sun.png' });
    await runScenario(service, {
      message: 'Generate a sun icon.',
      transcript: [
        { tool_calls: [{ id: 'g1', name: 'generate_image', arguments: sun }] },
        { tool_calls: [{ id: 'g2', name: 'generate_image', arguments: sun }] }, // exact redo
        { content: 'Done — here is your sun icon.' },
      ],
      toolResults: {
        generate_image: { result: { success: true, imageUrl: 'https://s3/sun.png', filename: 'sun.png' } },
      },
    });

    // The redo in iteration 2 must NOT actually regenerate — only one real execution.
    expect(imageGenExecCount(service)).toBe(1);
  });

  it('does NOT suppress a distinct variant across iterations', async () => {
    await runScenario(service, {
      message: 'Generate a sun, then a moon.',
      transcript: [
        { tool_calls: [{ id: 'g1', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a sun', filename: 'sun.png' }) }] },
        { tool_calls: [{ id: 'g2', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a moon', filename: 'moon.png' }) }] },
        { content: 'Done — sun and moon.' },
      ],
      toolResults: {
        generate_image: { result: { success: true, imageUrl: 'https://s3/img.png' } },
      },
    });

    // Two genuinely different variants both generate — no over-suppression.
    expect(imageGenExecCount(service)).toBe(2);
  });
});
