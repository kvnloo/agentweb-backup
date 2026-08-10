/**
 * ENG-1054 regression: the agent must never end a turn on serialization residue.
 *
 * Production repro (session with 215 messages, $29.67 of compute): the model
 * executed the user's urgent campaign-pause calls, then its final turn emitted the
 * literal two-character string "}]" as its entire answer. The loop's only
 * failed-synthesis guard was `!content`, so "}]" was non-empty, was accepted as the
 * final response, was persisted, and every remaining deliverable of the turn was
 * lost — with no record of what had actually been executed.
 *
 * These run the REAL `generateMarketingResponse` through the characterization
 * harness, so they fail against the pre-fix loop and pass after it.
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

describe('AgentMode — broken-JSON final synthesis guard (ENG-1054)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  it('re-asks for the synthesis instead of shipping a "}]" final turn', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pause both new campaigns, then show me the brand guidelines.',
      transcript: [
        {
          tool_calls: [
            { id: 'call-a1', name: 'read_brand_guidelines', arguments: '{}' },
          ],
        },
        // The production failure: a text-only turn whose whole content is residue.
        { content: '}]' },
        // The retry the loop should now perform.
        { content: 'I paused both campaigns. Your brand guidelines are attached below.' },
      ],
      toolResults: {
        read_brand_guidelines: {
          result: JSON.stringify({ success: true, brand: 'Acme' }),
        },
      },
    });

    expect(snapshot.content).not.toBe('}]');
    expect(snapshot.content).toBe('I paused both campaigns. Your brand guidelines are attached below.');
    // Turn 1 (tools) + turn 2 (residue) + turn 3 (the synthesis retry).
    expect(snapshot.llmTurnsConsumed).toBe(3);
  });

  it('never persists the residue into the transcript', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pause both new campaigns.',
      transcript: [
        { tool_calls: [{ id: 'call-b1', name: 'read_brand_guidelines', arguments: '{}' }] },
        { content: '}]' },
        { content: 'Both campaigns are paused.' },
      ],
    });

    const assistantTexts = (snapshot.responseMessageShape || []).length;
    expect(assistantTexts).toBeGreaterThan(0);
    expect(snapshot.content).toBe('Both campaigns are paused.');
  });

  it('falls back to the executed-action ledger when the retry also returns residue', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pause both new campaigns.',
      transcript: [
        {
          tool_calls: [
            { id: 'call-c1', name: 'read_brand_guidelines', arguments: '{}' },
          ],
        },
        { content: '}]' },
        // The bounded synthesis retry is exhausted and the model returns residue again.
        { content: '}' },
      ],
    });

    // The user must NOT receive residue, and must NOT receive a blank reply either:
    // the record of what actually executed has to survive the synthesis failure.
    expect(snapshot.content).not.toBe('}]');
    expect(snapshot.content).not.toBe('}');
    expect(snapshot.content.trim().length).toBeGreaterThan(0);
    expect(snapshot.content).toContain('read_brand_guidelines');
  });

  it('leaves a normal final answer untouched', async () => {
    const snapshot = await runScenario(service, {
      message: 'Summarize my brand.',
      transcript: [
        { tool_calls: [{ id: 'call-d1', name: 'read_brand_guidelines', arguments: '{}' }] },
        { content: 'Your brand is focused on B2B SaaS marketing.' },
      ],
    });

    expect(snapshot.content).toBe('Your brand is focused on B2B SaaS marketing.');
    expect(snapshot.llmTurnsConsumed).toBe(2);
  });
});
