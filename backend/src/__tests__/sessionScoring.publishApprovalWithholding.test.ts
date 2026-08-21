/**
 * ENG-1245: judges scored a REAL, owner-set "Require approval before
 * publishing" hold as a fabricated/simulated restriction ("falsely
 * claiming", "simulated"), because they only ever see the schedule's own
 * prompt prose (e.g. "(Autonomous)", "no approval needed") and have no
 * signal that the block came from a real account-level setting
 * (agentModeService.publishApprovalBlock()). This penalized goalCompletion
 * for a run that correctly withheld publishing per ENG-803/ENG-827 consent
 * rules.
 *
 * The new clause is APPENDED at call time (same pattern as
 * NO_TASK_JUDGMENT_CLAUSE / VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE), not
 * merged into DEFAULT_SCORING_SYSTEM_PROMPT's literal text — production has
 * a live `default-scoring-prompt` AW-Settings override, and a custom
 * ScoringJudge.systemPrompt (Fangfang Judge, Matt Judge) is entirely
 * user-authored, so editing only the hardcoded default would leave the
 * judges that actually reproduced this bug blind to the fix (ENG-392).
 */
import {
  scoreSession,
  scoreSessionWithJudge,
  DEFAULT_SCORING_SYSTEM_PROMPT,
  PUBLISH_APPROVAL_WITHHOLDING_CLAUSE,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: jest.fn(),
    resolveGenerationModel: (m: string) => ({ model: m, fellBack: false, requestedModel: m }),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    updateSessionSatisfactionScore: jest.fn().mockResolvedValue({}),
    updateSessionJudgeScore: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;

function makeLLMResponse(score: number, dimensions: Record<string, unknown>, reason = 'r') {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, dimensions }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

const blockedMessages: ChatMessage[] = [
  { role: 'user', content: 'Draft and post today\'s tweet — no approval, autonomous run.' },
  {
    role: 'assistant',
    content: 'Drafted a tweet.',
    metadata: { toolCalls: [{ name: 'twitter_manage_post' }] },
  } as any,
  {
    role: 'tool',
    name: 'twitter_manage_post',
    content: JSON.stringify({
      success: false,
      error:
        'Blocked: this schedule has "Require approval before publishing" turned ON, so twitter_manage_post cannot publish on the owner\'s behalf in an unattended run. This is an account-level setting on the schedule',
      publishApprovalRequired: true,
    }),
  } as any,
  { role: 'assistant', content: 'Saved the draft; nothing was published because approval is required on this schedule.' },
];

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Custom Judge',
  systemPrompt: 'You are a custom judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SessionScoring - publish-approval withholding is not a fabrication (ENG-1245)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('regression guard: DEFAULT_SCORING_SYSTEM_PROMPT must never hardcode the publish-approval rule (appended, not baked in, so an AW-Settings override cannot mask it) — does not by itself prove the ENG-1245 fix works', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toContain('Require approval before publishing');
  });

  it('PUBLISH_APPROVAL_WITHHOLDING_CLAUSE tells the judge the hold is real, not fabricated', () => {
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toContain('Require approval before publishing');
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/account-level/i);
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/falsely claim|simulat|fabricat/i);
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/goalCompletion/);
  });

  it('PUBLISH_APPROVAL_WITHHOLDING_CLAUSE says prompt prose is not authoritative over the account-level gate', () => {
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/prompt text|prompt prose/i);
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/not authoritative|even if/i);
  });

  /**
   * ENG-1245 (re-verified): the clause originally told the judge this restriction is
   * always "an owner-configured account/schedule setting". That is only true for the
   * literal "Require approval before publishing" toggle. Schedule
   * 1d001fba-0fb7-4bcd-80f6-6041b244a442 ("Harsha Daily X Post (Autonomous)") has that
   * toggle OFF and has posted nothing since 2026-08-13 because it was simply never
   * granted standing publish authorization — a real, code-enforced restriction, but
   * not one the owner deliberately switched on. The judge must not penalize either
   * case, but it also must not itself assert a specific cause ("the owner turned this
   * on") the transcript does not actually support — that just relocates the same
   * fabrication into the judge's own "reason" text instead of the assistant's.
   */
  it('PUBLISH_APPROVAL_WITHHOLDING_CLAUSE does not assume the owner deliberately switched the setting on', () => {
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).not.toContain('owner-configured account/schedule setting');
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/never been granted|not.{0,20}deliberately|standing.{0,20}authorization/i);
  });

  /**
   * ENG-1245 (found in re-review, not filed as a ticket) — getScheduledSessionOverride
   * gained a THIRD withheld branch ('revoked': the owner previously granted standing
   * publish authorization and has since revoked it — see
   * describePublishAuthorizationWithholdReason in schedulePublishAuthorization.ts) whose
   * report text says "this schedule's publish authorization has been revoked" and does
   * NOT contain the phrase "account-level setting" or "has not been granted standing
   * authorization" — the two phrases this clause explicitly lists as recognized real
   * reasons. A judge doing careful, literal reading of the clause's own trigger list
   * could plausibly conclude a revoked-authorization report matches none of them and
   * score it as a fabrication — recreating this exact ticket's failure for the one case
   * where the owner made the clearest, most deliberate decision of all three branches.
   * This is not a hypothetical judge behavior to guard against blindly — literal,
   * narrow reading of a rubric is exactly what produced the original bug.
   */
  it('PUBLISH_APPROVAL_WITHHOLDING_CLAUSE explicitly recognizes a REVOKED authorization as real too, not just never-granted', () => {
    expect(PUBLISH_APPROVAL_WITHHOLDING_CLAUSE).toMatch(/revoked/i);
  });

  it('scoreSession appends the clause to the system prompt sent to the LLM', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSession(blockedMessages, blockedMessages.length);

    expect(getSystemPrompt()).toContain('Require approval before publishing');
    expect(getSystemPrompt()).toContain('account-level');
  });

  it('scoreSessionWithJudge appends the clause even for a fully custom judge prompt (Fangfang/Matt Judge)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, { goalCompletion: 5, dataAccuracy: 5, outputQuality: 5 }));

    await scoreSessionWithJudge(blockedMessages, blockedMessages.length, judge);

    const prompt = getSystemPrompt();
    expect(prompt).toContain('You are a custom judge.');
    expect(prompt).toContain('Require approval before publishing');
  });

});
