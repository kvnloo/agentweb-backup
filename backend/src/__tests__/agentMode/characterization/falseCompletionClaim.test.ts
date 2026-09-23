/**
 * ENG-1331 — live-loop proof that a FLUENT final synthesis claiming more assets
 * were completed than the ledger shows gets corrected before it reaches the user.
 *
 * Prod signature (session b78a3203, gemini-3.1-pro-preview, predefined work plan
 * "Display Ad Set Production — One Master, Every Size"): the model rendered and
 * screenshot-exported only 4 of 12 requested display-ad sizes for a variant run,
 * then closed with "All 12 sizes have been rendered, QA'd, and saved" — fluent,
 * well-formed prose. The ENG-1054 residue guard (`isUnusableSynthesis`) never
 * flags it because it isn't junk-shaped; nothing else in the loop checked the
 * model's own numeric claim against what it actually did.
 *
 * Only `callLLM` / leaf `executeTool` are scripted; the real loop (including the
 * real tool dispatch and the new ENG-1331 completion-claim check) runs for real.
 */

import { AgentModeService } from '../../../services/agentModeService';
import { buildLLMResponse, installStandardMockDeps } from './harness';

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

const FALSE_CLAIM =
  "All 12 sizes have been rendered, QA'd, and saved for Variant 4. Here is the contact sheet.";

// Distinct `filename` per call — the loop suppresses same-tool calls with
// identical arguments as duplicates, so identical args would collapse all 4
// screenshots into 1 executed call and misrepresent the scenario being tested.
function screenshotCall(id: string, filename: string) {
  return { id, name: 'playwright_browser_take_screenshot', arguments: JSON.stringify({ filename }) };
}

describe('ENG-1331 — a fluent final answer cannot claim more assets than the ledger shows', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    installStandardMockDeps();
  });

  async function runScriptedLoop(turns: any[]) {
    let call = 0;
    jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
      return buildLLMResponse(turns[Math.min(call++, turns.length - 1)]);
    });
    jest.spyOn(service as any, 'executeTool').mockImplementation(async (...args: any[]) => {
      const toolName: string = args[1];
      if (toolName === 'playwright_browser_take_screenshot') {
        return { screenshotUrl: `https://s3.example.com/${call}.png`, success: true };
      }
      return JSON.stringify({ success: true, data: `mock:${toolName}` });
    });
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = (await service.generateMarketingResponse(
      'Render the full 12-size IAB matrix for Variant 4.',
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;
    return { result, llmCalls: call };
  }

  it('appends a correction when the closing message claims all 12 but only 4 screenshots succeeded', async () => {
    const { result } = await runScriptedLoop([
      // Only 4 of the 12 requested sizes are actually rendered this turn.
      {
        tool_calls: [
          screenshotCall('c1', '300x250.png'),
          screenshotCall('c2', '728x90.png'),
          screenshotCall('c3', '160x600.png'),
          screenshotCall('c4', '320x50.png'),
        ],
      },
      // The model falsely claims all 12 were completed.
      { content: FALSE_CLAIM },
    ]);

    expect(result.content).toContain(FALSE_CLAIM);
    // The false "12" claim must be visibly corrected against the real "4".
    expect(result.content).toContain('only 4 of 12');
    expect(result.content).toContain('playwright_browser_take_screenshot');
  });

  it('does NOT correct a closing message whose claim matches what actually ran', async () => {
    const { result } = await runScriptedLoop([
      {
        tool_calls: [
          screenshotCall('c1', '300x250.png'),
          screenshotCall('c2', '728x90.png'),
          screenshotCall('c3', '160x600.png'),
          screenshotCall('c4', '320x50.png'),
        ],
      },
      { content: 'All 4 sizes have been rendered, QA\'d, and saved.' },
    ]);

    expect(result.content).toBe('All 4 sizes have been rendered, QA\'d, and saved.');
    expect(result.content).not.toContain('Correction');
  });

  it('ENG-1635/1644: does NOT correct a closing message that narrates an approval-deck outcome, even with zero tool calls this turn', async () => {
    // Deck-approved writes dispatch via buildMetaWriteWorkflowSteps().execute() in
    // the controller, BEFORE generateMarketingResponse (and its own toolCalls
    // ledger) ever runs. A turn that just narrates the already-injected
    // "[Approval deck outcome: ...]" note has a genuinely empty toolCalls ledger
    // for THIS turn even though 6 real creatives were dispatched moments earlier —
    // found live-driving env1 (2026-09-16): this guard fired a false "0 of 6 were
    // actually produced" correction directly under a summary table of 6 real,
    // verified creative IDs.
    const DECK_OUTCOME_CLAIM =
      'All 6 ad creatives have been successfully created and verified across the 3 image variants and 2 headline angles.';
    const messageWithDeckOutcome =
      'Now create 6 ad creatives for that ad set.\n\n[Approval deck outcome: ' +
      '{"status":"fully_applied","items":[{"stepId":"write-1","status":"verified"},{"stepId":"write-2","status":"verified"},' +
      '{"stepId":"write-3","status":"verified"},{"stepId":"write-4","status":"verified"},{"stepId":"write-5","status":"verified"},' +
      '{"stepId":"write-6","status":"verified"}]}]';

    const executeToolMock = jest.fn();
    jest.spyOn(service as any, 'callLLM').mockImplementation(async () => {
      return buildLLMResponse({ content: DECK_OUTCOME_CLAIM });
    });
    jest.spyOn(service as any, 'executeTool').mockImplementation(executeToolMock);
    jest.spyOn(service as any, 'generateSuggestedReplies').mockResolvedValue([]);

    const result = (await service.generateMarketingResponse(
      messageWithDeckOutcome,
      [] as any,
      'test-user',
      service.default_model,
      'test-session',
    )) as any;

    expect(result.content).toBe(DECK_OUTCOME_CLAIM);
    expect(result.content).not.toContain('Correction');
    expect(executeToolMock).not.toHaveBeenCalled();
  });
});
