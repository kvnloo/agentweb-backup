/**
 * ENG-1054: the residue guard discards model output, and its failure mode is silent
 * — a false positive costs the user their answer and surfaces only as a log line.
 * Merging here deploys straight to production, so AGENT_SYNTHESIS_RESIDUE_GUARD=false
 * must restore the exact pre-fix behaviour without a revert. A kill switch nobody has
 * proven works is not a control, so this drives the real loop with it set.
 */

import { AgentModeService } from '../../services/agentModeService';
import { runScenario, installStandardMockDeps } from './characterization/harness';

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

const RESIDUE_SCENARIO = {
  message: 'Pause both new campaigns.',
  transcript: [
    { tool_calls: [{ id: 'call-k1', name: 'read_brand_guidelines', arguments: '{}' }] },
    { content: '}]' },
    { content: 'Both campaigns are paused.' },
  ],
};

describe('AgentMode — residue guard kill switch (ENG-1054)', () => {
  let service: AgentModeService;
  const original = process.env.AGENT_SYNTHESIS_RESIDUE_GUARD;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENT_SYNTHESIS_RESIDUE_GUARD;
    else process.env.AGENT_SYNTHESIS_RESIDUE_GUARD = original;
  });

  it('guards by default (flag unset)', async () => {
    delete process.env.AGENT_SYNTHESIS_RESIDUE_GUARD;
    const snapshot = await runScenario(service, RESIDUE_SCENARIO);
    expect(snapshot.content).not.toBe('}]');
    expect(snapshot.llmTurnsConsumed).toBe(3); // residue -> retry
  });

  it('still guards for any value other than the literal "false"', async () => {
    process.env.AGENT_SYNTHESIS_RESIDUE_GUARD = 'true';
    const snapshot = await runScenario(service, RESIDUE_SCENARIO);
    expect(snapshot.content).not.toBe('}]');
  });

  it('=false restores the pre-fix behaviour exactly: "}]" ships, no retry, no recap', async () => {
    process.env.AGENT_SYNTHESIS_RESIDUE_GUARD = 'false';
    const snapshot = await runScenario(service, RESIDUE_SCENARIO);

    // The original bug, deliberately reinstated — that is what "off" has to mean.
    expect(snapshot.content).toBe('}]');
    expect(snapshot.content).not.toContain("didn't come through correctly");
    // No synthesis retry fired, so the third transcript turn was never consumed.
    expect(snapshot.llmTurnsConsumed).toBe(2);
  });
});
