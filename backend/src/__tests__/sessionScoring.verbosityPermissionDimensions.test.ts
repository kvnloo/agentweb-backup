/**
 * ENG-1312: the satisfaction judge was blind to verbosity, permission-asking,
 * and length-instruction compliance. This adds three new judge signals —
 * concision, instructionCompliance, unnecessaryPermissionRequest — plus a rule
 * that pushback against an explicit non-spend/non-publish instruction cannot
 * score outputQuality=5.
 *
 * The new clause is APPENDED at call time (same pattern as
 * NO_TASK_JUDGMENT_CLAUSE), not merged into DEFAULT_SCORING_SYSTEM_PROMPT's
 * literal text — production has a live `default-scoring-prompt` AW-Settings
 * override, and editing only the hardcoded default would leave the *actual*
 * live judge blind to these dimensions (ENG-392's exact failure class, which
 * is what created the blind spot ENG-1312 exists to fix).
 */
import {
  scoreSession,
  scoreSessionWithJudge,
  DEFAULT_SCORING_SYSTEM_PROMPT,
  VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE,
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

function makeLLMResponse(score: number, dimensions: Record<string, unknown>) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason: 'r', dimensions }) } }],
  } as any;
}

function getSystemPrompt(callIndex = 0): string {
  const callArgs = mockCallLLM.mock.calls[callIndex];
  const systemMessage = callArgs[1].find((m: any) => m.role === 'system');
  return systemMessage?.content ?? '';
}

const messages: ChatMessage[] = [
  { role: 'user', content: 'Condense this down to maximum of 2 pages.' },
  { role: 'assistant', content: 'Here is the condensed version.' },
];

const judge: ScoringJudge = {
  id: 'judge-1',
  name: 'Custom Judge',
  systemPrompt: 'You are a custom judge.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SessionScoring - verbosity/permission judge dimensions (ENG-1312)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests -------------------------------------------------------------

  it('DEFAULT_SCORING_SYSTEM_PROMPT does NOT hardcode the new dimensions (they are appended, not baked in, so an AW-Settings override cannot mask them)', () => {
    expect(DEFAULT_SCORING_SYSTEM_PROMPT).not.toContain('unnecessaryPermissionRequest');
  });

  it('VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE requires concision, instructionCompliance, and unnecessaryPermissionRequest', () => {
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toContain('concision');
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toContain('instructionCompliance');
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toContain('unnecessaryPermissionRequest');
  });

  it('VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE states pushback cannot score outputQuality 5 on a non-spend/non-publish instruction', () => {
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toMatch(/outputQuality/);
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toMatch(/not.*score.*5|may not score 5/i);
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toMatch(/spend|publish|send/i);
  });

  it('VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE exempts a required safety refusal from the pushback cap (CodeRabbit, PR #2443)', () => {
    // The pushback rule targets arguing with an ordinary instruction, not a
    // correct refusal of a harmful/illegal/privacy-violating request — that
    // refusal must remain eligible for outputQuality 5.
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toMatch(/harmful|illegal|privacy/i);
    expect(VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE).toMatch(/safety/i);
  });

  it('scoreSession appends the clause to the system prompt sent to the LLM', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, {
      goalCompletion: 4, dataAccuracy: 4, outputQuality: 4,
      concision: 2, instructionCompliance: 2, unnecessaryPermissionRequest: false,
    }));

    await scoreSession(messages, 2);

    expect(getSystemPrompt()).toContain('concision');
    expect(getSystemPrompt()).toContain('unnecessaryPermissionRequest');
  });

  it('scoreSessionWithJudge appends the clause even for a fully custom judge prompt', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, {
      goalCompletion: 4, dataAccuracy: 4, outputQuality: 4,
      concision: 2, instructionCompliance: 2, unnecessaryPermissionRequest: false,
    }));

    await scoreSessionWithJudge(messages, 2, judge);

    const prompt = getSystemPrompt();
    expect(prompt).toContain('You are a custom judge.');
    expect(prompt).toContain('concision');
    expect(prompt).toContain('unnecessaryPermissionRequest');
  });

  it('a malformed unnecessaryPermissionRequest (non-boolean) is dropped, not coerced', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, {
      goalCompletion: 4, dataAccuracy: 4, outputQuality: 4,
      concision: 3, instructionCompliance: 3, unnecessaryPermissionRequest: 'yes',
    }));

    const result = await scoreSession(messages, 2);

    expect(result.dimensions?.unnecessaryPermissionRequest).toBeUndefined();
    // the base three dimensions still parse even though the new field was malformed
    expect(result.dimensions?.goalCompletion).toBe(4);
  });

  it('a missing concision/instructionCompliance leaves them undefined without breaking the base dimensions (backward compatible with a stale custom judge prompt)', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(4, {
      goalCompletion: 4, dataAccuracy: 4, outputQuality: 4,
    }));

    const result = await scoreSession(messages, 2);

    expect(result.dimensions?.goalCompletion).toBe(4);
    expect(result.dimensions?.concision).toBeUndefined();
    expect(result.dimensions?.instructionCompliance).toBeUndefined();
    expect(result.dimensions?.unnecessaryPermissionRequest).toBeUndefined();
  });

  // SUCCESS tests ------------------------------------------------------------

  it('parses concision and instructionCompliance and clamps to the 0-5 range', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(2, {
      goalCompletion: 2, dataAccuracy: 4, outputQuality: 2,
      concision: 9, instructionCompliance: -3, unnecessaryPermissionRequest: false,
    }));

    const result = await scoreSession(messages, 2);

    expect(result.dimensions?.concision).toBe(5); // clamped from 9
    expect(result.dimensions?.instructionCompliance).toBe(0); // clamped from -3
  });

  it('parses unnecessaryPermissionRequest=true', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, {
      goalCompletion: 5, dataAccuracy: 5, outputQuality: 5,
      concision: 5, instructionCompliance: 5, unnecessaryPermissionRequest: true,
    }));

    const result = await scoreSession(messages, 2);

    expect(result.dimensions?.unnecessaryPermissionRequest).toBe(true);
  });

  it('a control session with terse, on-target dimensions scores concision and instructionCompliance >= 4', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(5, {
      goalCompletion: 5, dataAccuracy: 5, outputQuality: 5,
      concision: 5, instructionCompliance: 5, unnecessaryPermissionRequest: false,
    }));

    const result = await scoreSession(messages, 2);

    expect(result.dimensions?.concision).toBeGreaterThanOrEqual(4);
    expect(result.dimensions?.instructionCompliance).toBeGreaterThanOrEqual(4);
  });

  it('scoreSessionWithJudge also parses the new dimensions', async () => {
    mockCallLLM.mockResolvedValue(makeLLMResponse(2, {
      goalCompletion: 2, dataAccuracy: 4, outputQuality: 2,
      concision: 1, instructionCompliance: 2, unnecessaryPermissionRequest: true,
    }));

    const result = await scoreSessionWithJudge(messages, 2, judge);

    expect(result.dimensions?.concision).toBe(1);
    expect(result.dimensions?.instructionCompliance).toBe(2);
    expect(result.dimensions?.unnecessaryPermissionRequest).toBe(true);
  });
});
