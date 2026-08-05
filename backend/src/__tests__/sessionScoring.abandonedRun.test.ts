import {
  scoreSessionIfNeeded,
  scoreSessionWithJudgeIfNeeded,
  ScoringJudge,
} from '../services/sessionScoringService';
import { ChatMessage, chatbotDb } from '../services/chatbotService';
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
    addMessageToSession: jest.fn().mockResolvedValue({}),
    updateSessionError: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

const mockCallLLM = agentModeService.callLLM as jest.MockedFunction<typeof agentModeService.callLLM>;
const mockUpdateScore = chatbotDb.updateSessionSatisfactionScore as jest.Mock;
const mockUpdateJudgeScore = chatbotDb.updateSessionJudgeScore as jest.Mock;
const mockAddMessage = chatbotDb.addMessageToSession as jest.Mock;

function makeLLMResponse(score: number, reason: string, dimensions?: object) {
  return {
    choices: [{ message: { content: JSON.stringify({ score, reason, ...(dimensions ? { dimensions } : {}) }) } }],
  } as any;
}

const isoMinutesAgo = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();
const STALE = () => isoMinutesAgo(90);
const RECENT = () => isoMinutesAgo(2);

const testJudge: ScoringJudge = {
  id: 'judge-1',
  name: 'Test Judge',
  systemPrompt: 'Rate this conversation.',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// A scheduled run whose owning process died mid-flight after a real, side-effecting
// tool call (enrich_leads_execute). The ENG-324 reconciler recovered it and appended
// a `jobIncomplete` placeholder as the LAST turn — the run did real work but never
// emitted its final summary. This is the exact shape of the ENG-764 session: the
// transcript "cuts off after a tool call", so the LLM judge previously mis-scored it
// low on goalCompletion/outputQuality even though the abandonment is an infra failure.
const abandonedAfterToolCall: ChatMessage[] = [
  { role: 'system', content: 'You are an automated scheduled run.' } as any,
  { role: 'user', content: 'Enrich the priority lead lists and summarize.' },
  { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'enrich_leads_execute' }] } } as any,
  { role: 'tool', name: 'enrich_leads_execute', content: '{"enriched": 40}' } as any,
  {
    role: 'assistant',
    content: "This run didn't finish — it looks like it stopped before producing a response.",
    metadata: { isErrorMessage: true, jobIncomplete: true },
  } as any,
];

// Same shape but with the ENG-473 `isRunFailureNotice` variant of the placeholder.
const abandonedWithRetryNotice: ChatMessage[] = [
  { role: 'system', content: 'You are an automated scheduled run.' } as any,
  { role: 'user', content: 'Run the enrichment.' },
  { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'enrich_leads_execute' }] } } as any,
  { role: 'tool', name: 'enrich_leads_execute', content: '{"enriched": 12}' } as any,
  {
    role: 'assistant',
    content: 'This run didn\'t finish — please retry.',
    metadata: { isErrorMessage: true, isRunFailureNotice: true },
  } as any,
];

// A run that crashed (placeholder) but was then RETRIED in the same session and
// completed with a genuine final assistant turn. This must still be scored normally
// by the LLM judge — the placeholder is NOT the last turn.
const crashedThenRetriedAndCompleted: ChatMessage[] = [
  { role: 'user', content: 'Do the enrichment.' },
  { role: 'assistant', content: '', metadata: { toolCalls: [{ name: 'enrich_leads_execute' }] } } as any,
  { role: 'tool', name: 'enrich_leads_execute', content: '{"enriched": 5}' } as any,
  { role: 'assistant', content: '', metadata: { isErrorMessage: true, jobIncomplete: true } } as any,
  { role: 'user', content: 'retry' },
  { role: 'assistant', content: 'Done — I enriched 5 leads. Here is the summary and recommended next steps.' } as any,
];

describe('SessionScoring - abandoned runs recovered by the reconciler (ENG-764)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scoreSessionIfNeeded scores a jobIncomplete-terminated run 1/5 as a failed run without invoking the judge', async () => {
    const session = {
      sessionId: 'abandoned-1',
      userId: 'u1',
      sessionType: 'scheduled',
      pageIdentifier: 'Scheduled: Lead Auto-Enrichment|scheduleId:abc',
      messages: abandonedAfterToolCall,
      messageCount: abandonedAfterToolCall.length,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(1);
    expect(result?.dimensions).toEqual({ goalCompletion: 1, dataAccuracy: 1, outputQuality: 1 });
    // The abandonment is deterministic — never send the truncated transcript to the judge.
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateScore).toHaveBeenCalledTimes(1);
    // The reconciler already left the placeholder, so no second notice is added.
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('scoreSessionWithJudgeIfNeeded scores a jobIncomplete-terminated run 1/5 as a failed run', async () => {
    const session = {
      sessionId: 'abandoned-2',
      userId: 'u1',
      sessionType: 'scheduled',
      pageIdentifier: 'Scheduled: Lead Auto-Enrichment|scheduleId:abc',
      messages: abandonedAfterToolCall,
      messageCount: abandonedAfterToolCall.length,
      judgeScores: {},
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionWithJudgeIfNeeded(session, testJudge);

    expect(result).not.toBeNull();
    expect(result?.score).toBe(1);
    expect(result?.dimensions).toEqual({ goalCompletion: 1, dataAccuracy: 1, outputQuality: 1 });
    expect(result?.judgeName).toBe('Test Judge');
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockUpdateJudgeScore).toHaveBeenCalledTimes(1);
  });

  it('also treats the ENG-473 isRunFailureNotice placeholder as a deterministic failed run', async () => {
    const session = {
      sessionId: 'abandoned-3',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: abandonedWithRetryNotice,
      messageCount: abandonedWithRetryNotice.length,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result?.score).toBe(1);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('defers an abandoned-after-tool-call session still within the grace window (resume may be racing)', async () => {
    const session = {
      sessionId: 'abandoned-recent',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: abandonedAfterToolCall,
      messageCount: abandonedAfterToolCall.length,
      createdAt: RECENT(),
      updatedAt: RECENT(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result).toBeNull();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('still scores a crashed-then-retried-and-completed session normally with the judge', async () => {
    mockCallLLM.mockResolvedValue(
      makeLLMResponse(4, 'Completed after retry', { goalCompletion: 4, dataAccuracy: 4, outputQuality: 4 })
    );
    const session = {
      sessionId: 'retried-1',
      userId: 'u1',
      sessionType: 'scheduled',
      messages: crashedThenRetriedAndCompleted,
      messageCount: crashedThenRetriedAndCompleted.length,
      createdAt: STALE(),
      updatedAt: STALE(),
    } as any;

    const result = await scoreSessionIfNeeded(session);

    expect(result?.score).toBe(4);
    // The placeholder is NOT the last turn — a genuine completion followed, so the
    // judge must run (and never see the stripped placeholder).
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });
});
