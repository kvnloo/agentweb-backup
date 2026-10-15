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
import { runScenario, runScenarioWithResult, installStandardMockDeps } from './harness';

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
    // ENG-1945 (root-cause follow-up): install_skills executes exactly ONCE per
    // batch — the eager Phase-1 head start IS the tool's only real execution (routed
    // through the gateway, after contract validation/policy so it never mutates
    // session state ahead of a call Phase 1 goes on to preflight-reject); Phase 2
    // replays that cached outcome rather than re-running the tool. A second,
    // independent execution isn't just redundant, it double-records failures against
    // the gateway's per-run breaker and silently halves install_skills' retry budget
    // (see toolDispatch.test.ts's breaker-budget regression test). The harness's
    // `executeTool` mock is keyed only by tool name, so `toolCallSequence` (populated
    // solely from the Phase-2 ledger entry) can't see this — spy on `executeTool`
    // directly to lock in the intended invocation count.
    const executeToolSpy = jest.spyOn(service as any, 'executeTool');

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

    const installSkillsCalls = executeToolSpy.mock.calls.filter(([, toolName]) => toolName === 'install_skills');
    expect(installSkillsCalls).toHaveLength(1);
  });

  it('a sibling gated tool stays blocked when install_skills rejects an unresolvable skill id in the same batch', async () => {
    const { snapshot, result } = await runScenarioWithResult(service, {
      message: 'Install the browser skill and pull the Luma guest list.',
      transcript: [
        {
          tool_calls: [
            { id: 'i1', name: 'install_skills', arguments: '{"skillIds":["no-such-skill"]}' },
            { id: 'n1', name: 'playwright_browser_navigate', arguments: '{"url":"https://luma.com/guests"}' },
          ],
        },
        { content: 'Could not install the requested skill, so navigation did not run.' },
      ],
      toolResults: {
        install_skills: {
          result: {
            success: false,
            message: 'Could not resolve these skill IDs to any known skill: no-such-skill.',
          },
        },
      },
    });

    // The sibling's preflight rejection is appended to the ledger synchronously during
    // Phase 1 (before install_skills' own Phase-2 gateway result lands), so it precedes
    // install_skills here even though the model emitted install_skills first.
    expect(snapshot.toolCallSequence).toEqual([
      { name: 'playwright_browser_navigate', arguments: { url: 'https://luma.com/guests' }, outcome: 'error' },
      { name: 'install_skills', arguments: { skillIds: ['no-such-skill'] }, outcome: 'error' },
    ]);
    expect(String(result.toolCalls[0].error)).toContain(
      'is not available. You must install the required skill first using install_skills.',
    );
  });

  describe('[tool-gate-refused] diagnostic (ENG-2299)', () => {
    const REFUSAL = 'is not available. You must install the required skill first using install_skills.';
    let warn: jest.SpyInstance;

    const refusedLines = () => warn.mock.calls
      .filter(([tag]) => tag === '[tool-gate-refused]')
      .map(([, json]) => JSON.parse(json as string));

    beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
    afterEach(() => warn.mockRestore());

    it('logs which skill claims a refused tool and leaves the refusal text unchanged', async () => {
      const { result } = await runScenarioWithResult(service, {
        message: 'Open the page.',
        transcript: [
          { tool_calls: [{ id: 'n1', name: 'playwright_browser_navigate', arguments: '{"url":"https://x.test"}' }] },
          { content: 'Could not navigate.' },
        ],
        toolResults: {},
      });

      expect(String(result.toolCalls[0].error)).toContain(`Tool "playwright_browser_navigate" ${REFUSAL}`);
      const [line] = refusedLines();
      expect(line).toMatchObject({
        tool: 'playwright_browser_navigate',
        entitlementResolved: true,
        installedSkillIds: ['linkedin-skill'],
        otherSkillsInstalled: false,
        inOtherSkillsPool: false,
        catalogSize: 2,
        claimedBy: [{ skillId: 'browser-skill', installed: false, tierAllows: true }],
      });
    });

    it('still refuses with the same text when the describer throws', async () => {
      jest.spyOn(service, 'describeToolGateRefusal').mockImplementation(() => { throw new Error('boom'); });
      const { result } = await runScenarioWithResult(service, {
        message: 'Open the page.',
        transcript: [
          { tool_calls: [{ id: 'n1', name: 'playwright_browser_navigate', arguments: '{"url":"https://x.test"}' }] },
          { content: 'Could not navigate.' },
        ],
        toolResults: {},
      });

      expect(String(result.toolCalls[0].error)).toContain(`Tool "playwright_browser_navigate" ${REFUSAL}`);
      expect(refusedLines()[0]).toMatchObject({ tool: 'playwright_browser_navigate', describeError: true });
    });

    it('reports a skill installed earlier in the same turn, not the turn-start list', async () => {
      const getChatSession = (require('../../../services/chatbotService').chatbotDb.getChatSession as jest.Mock);
      getChatSession
        .mockResolvedValueOnce({ sessionId: 'test-session', messages: [], associatedSkills: ['linkedin-skill'] })
        .mockResolvedValue({ sessionId: 'test-session', messages: [], associatedSkills: ['linkedin-skill', 'browser-skill'] });

      await runScenarioWithResult(service, {
        message: 'Install the browser skill, then check SEO.',
        transcript: [
          { tool_calls: [{ id: 'i1', name: 'install_skills', arguments: '{"skillIds":["browser-skill"]}' }] },
          { tool_calls: [{ id: 's1', name: 'get_seo_metrics', arguments: '{}' }] },
          { content: 'Done.' },
        ],
        toolResults: {
          install_skills: { result: { success: true, message: 'ok', installedSkills: ['Browser automation'], installedToolNames: ['playwright_browser_navigate'] } },
        },
      });

      const seo = refusedLines().find((l) => l.tool === 'get_seo_metrics');
      expect(seo?.installedSkillIds).toEqual(['linkedin-skill', 'browser-skill']);
      expect(seo?.claimedBy).toEqual([]);
    });
  });
});
