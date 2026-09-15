/**
 * ENG-1945: a model very commonly emits `install_skills` AND a tool that skill
 * gates in the SAME response ("install the browser skill, then navigate"). The
 * `allowedToolNames` preflight gate in core/toolDispatch.ts used to validate every
 * tool call in a batch against the set computed BEFORE this iteration's
 * install_skills call actually ran — so the sibling tool was rejected as
 * "not available" a beat before the install it depended on took effect, even
 * though install_skills itself reported success moments earlier in the same
 * batch. The tool only became callable on the NEXT loop iteration.
 *
 * This reproduces that exact shape with a REAL, non-legacy, skill-gated session
 * (unlike the wildcard-everything characterization harness mocks) so the
 * `publishedSkillsCount > 0 && sessionAssociatedSkillIdsCount > 0` gate is
 * actually active, then asserts the newly-unlocked tool succeeds in the SAME
 * batch as the install_skills call that grants it.
 */

import { AgentModeService } from '../../../services/agentModeService';
import { runScenario, installStandardMockDeps } from './harness';

jest.mock('openai');
jest.mock('../../../services/settingsService');
jest.mock('../../../services/db');
jest.mock('../../../services/chatbotService');
jest.mock('../../../utils/secretsManager');

// NOTE: duplicated (not shared with the module-scope const below) — jest.mock
// factories are hoisted above const/let declarations, so the factory cannot
// close over an outer variable.
jest.mock('../../../services/skillService', () => {
  const catalog = [
    {
      skillId: 'linkedin-skill',
      name: 'LinkedIn Outreach',
      description: 'Outreach',
      toolNames: ['linkedin_outreach'],
      isPublished: true,
    },
    {
      skillId: 'browser-skill',
      name: 'Browser automation',
      description: 'Browser automation',
      toolNames: ['playwright_browser_navigate'],
      isPublished: true,
    },
  ];
  return {
    skillService: {
      getPublishedSkills: jest.fn().mockResolvedValue(catalog),
      getSkillsAvailableToUser: jest.fn().mockResolvedValue(catalog),
      getSkillsByIds: jest.fn().mockImplementation((ids: string[]) =>
        Promise.resolve(catalog.filter((s) => ids.includes(s.skillId))),
      ),
    },
  };
});

const SKILL_CATALOG = [
  {
    skillId: 'linkedin-skill',
    name: 'LinkedIn Outreach',
    description: 'Outreach',
    toolNames: ['linkedin_outreach'],
    isPublished: true,
  },
  {
    skillId: 'browser-skill',
    name: 'Browser automation',
    description: 'Browser automation',
    toolNames: ['playwright_browser_navigate'],
    isPublished: true,
  },
];
jest.mock('../../../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));
jest.mock('../../../services/userSkillAccessService', () => ({
  resolveUserSkillAccess: jest.fn().mockResolvedValue({ sharedOrgId: undefined }),
}));

describe('AgentMode core loop — install_skills same-batch tool gate (ENG-1945)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    (require('../../../services/skillService').skillService.getPublishedSkills as jest.Mock)
      .mockResolvedValue(SKILL_CATALOG);
    (require('../../../services/skillService').skillService.getSkillsAvailableToUser as jest.Mock)
      .mockResolvedValue(SKILL_CATALOG);
    (require('../../../services/skillService').skillService.getSkillsByIds as jest.Mock)
      .mockImplementation((ids: string[]) => Promise.resolve(SKILL_CATALOG.filter((s) => ids.includes(s.skillId))));
    (require('../../../services/subscriptionService').getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
    (require('../../../services/subscriptionService').resolveSkillsToToolNames as jest.Mock).mockResolvedValue(['*']);
    (require('../../../services/subscriptionService').filterFunctionCalls as jest.Mock)
      .mockImplementation((tools: any) => tools);

    service = new AgentModeService();
    // Non-legacy session (associatedSkills is a real array, not undefined) that
    // already has ONE skill installed — sessionAssociatedSkillIdsCount > 0 — but
    // NOT the browser skill yet, matching the live incident (LinkedIn/CRM already
    // installed on the session, Browser automation installed mid-session).
    installStandardMockDeps({
      sessionId: 'test-session',
      messages: [],
      associatedSkills: ['linkedin-skill'],
    });
  });

  it('a tool unlocked by install_skills succeeds when requested in the SAME batch as the install', async () => {
    const snapshot = await runScenario(service, {
      message: 'Install the browser skill and pull the Luma guest list.',
      transcript: [
        {
          tool_calls: [
            { id: 'i1', name: 'install_skills', arguments: '{"skillIds":["browser-skill"]}' },
            { id: 'n1', name: 'playwright_browser_navigate', arguments: '{"url":"https://luma.com/guests"}' },
          ],
        },
        { content: 'Installed the browser skill and navigated to the guest list.' },
      ],
      toolResults: {
        install_skills: {
          result: {
            success: true,
            message: 'Successfully installed 1 skill(s).',
            installedSkills: ['Browser automation'],
            installedToolNames: ['playwright_browser_navigate'],
          },
        },
        playwright_browser_navigate: {
          result: { success: true, snapshot: '<page snapshot>' },
        },
      },
    });

    expect(snapshot.toolCallSequence).toEqual([
      { name: 'install_skills', arguments: { skillIds: ['browser-skill'] }, outcome: 'success' },
      { name: 'playwright_browser_navigate', arguments: { url: 'https://luma.com/guests' }, outcome: 'success' },
    ]);
  });
});
