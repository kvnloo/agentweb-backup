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
import { runScenario, runScenarioWithResult, installStandardMockDeps } from './characterization/harness';

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
    // The retry's answer is delivered verbatim. It is followed by the executed-action
    // recap: this turn's synthesis DID break once, and the record of what ran must
    // not depend on us judging whether the retry's prose is a real answer.
    expect(snapshot.content).toContain('I paused both campaigns. Your brand guidelines are attached below.');
    expect(snapshot.content).toContain('read_brand_guidelines');
    // Turn 1 (tools) + turn 2 (residue) + turn 3 (the synthesis retry).
    expect(snapshot.llmTurnsConsumed).toBe(3);
  });

  it('never persists the residue into the transcript', async () => {
    // The BehaviorSnapshot reduces responseMessages to roles/tool names and drops
    // their content, so it cannot see residue in the transcript. Assert on the raw
    // persisted messages — that is the claim this guard actually makes.
    const { snapshot, result } = await runScenarioWithResult(service, {
      message: 'Pause both new campaigns.',
      transcript: [
        { tool_calls: [{ id: 'call-b1', name: 'read_brand_guidelines', arguments: '{}' }] },
        { content: '}]' },
        { content: 'Both campaigns are paused.' },
      ],
    });

    const assistantTexts = (result.responseMessages ?? [])
      .filter((m: any) => m?.role === 'assistant')
      .map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')));

    expect(assistantTexts.length).toBeGreaterThan(0);
    for (const persisted of assistantTexts) {
      expect(persisted.trim()).not.toBe('}]');
      expect(persisted.trim()).not.toBe('}');
    }
    expect(snapshot.content).toContain('Both campaigns are paused.');
  });

  // The production shape: the first turn narrates ("I'll pause them now.") WHILE
  // requesting tools, so the loop's sticky `content` accumulator is non-empty long
  // before the residue-only final turn. Gating the guard on that accumulator makes
  // it inert — the residue is blanked but the loop still terminates as if answered.
  it('still re-asks when an earlier turn already narrated alongside its tool calls', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pause both new campaigns, then show me the brand guidelines.',
      transcript: [
        {
          content: "On it — I'll pause both campaigns now.",
          tool_calls: [{ id: 'call-e1', name: 'read_brand_guidelines', arguments: '{}' }],
        },
        { content: '}]' },
        { content: 'Both campaigns are paused. Here are your brand guidelines.' },
      ],
    });

    expect(snapshot.content).toContain('Both campaigns are paused. Here are your brand guidelines.');
    expect(snapshot.llmTurnsConsumed).toBe(3);
  });

  it('reports the executed-action ledger even when an earlier turn left stale narration', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pause both new campaigns.',
      transcript: [
        {
          content: "On it — I'll pause both campaigns now.",
          tool_calls: [{ id: 'call-f1', name: 'read_brand_guidelines', arguments: '{}' }],
        },
        { content: '}]' },
        { content: '}' },
      ],
    });

    // Stale narration from turn 1 must not stand in for the lost synthesis: the
    // user gets the truthful record of what ran instead.
    expect(snapshot.content).not.toBe("On it — I'll pause both campaigns now.");
    expect(snapshot.content).toContain('read_brand_guidelines');
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

  // The gap this closes: the retry emitted characters, so the old either/or gate
  // treated the turn as answered and dropped the ledger — even when those
  // characters were a fragment or drift rather than an answer. Observed live: a
  // retry returned 75 chars of unrelated text and the record of what ran was lost.
  it('keeps BOTH the retry\'s answer and the record of what executed', async () => {
    const snapshot = await runScenario(service, {
      message: 'Pause both new campaigns.',
      transcript: [
        { tool_calls: [{ id: 'call-g1', name: 'read_brand_guidelines', arguments: '{}' }] },
        { content: '}]' },
        // A retry that emits text but does not actually answer.
        { content: ' Do not repeat what you already said, and do not add any introductory text.' },
      ],
    });

    // The model's text survives — we never judge whether prose is "good enough".
    expect(snapshot.content).toContain('Do not repeat what you already said');
    // ...and so does the truthful record the user needs.
    expect(snapshot.content).toContain('read_brand_guidelines');
    expect(snapshot.content).toContain("didn't come through correctly");
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
