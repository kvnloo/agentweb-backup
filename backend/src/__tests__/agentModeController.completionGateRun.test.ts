/**
 * Integration test for the deterministic completion gate in runVerifiedChat,
 * driven through the real runScheduledChat → runVerifiedChat → generateSessionResponse
 * path (only the LLM worker is mocked).
 *
 * Bug being guarded (PR #1941 follow-up): a scheduled multi-entity run with no
 * keywords / required functions / work plan returns success on attempt 1 even if
 * the model admits it left work unfinished. The gate must:
 *   - issue a continuation turn when the run admits unfinished work, then succeed
 *     once the model reports completion;
 *   - NOT fire when the run is clean / only has legitimate blockers;
 *   - be bounded (never loop indefinitely).
 */

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn(),
    addMessagesToSession: jest.fn(),
    updateSessionTitle: jest.fn(),
    updateSessionLlmModel: jest.fn(),
    getMessagesFromMessagesTable: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(),
    getScheduledChatsDefaultModel: jest.fn(),
    getMarketingSystemPrompt: jest.fn(),
    generateSessionTitle: jest.fn(),
    generateScheduledChatSummary: jest.fn(),
    getFoundationToolNames: jest.fn().mockReturnValue(new Set(['install_skills', 'search_web'])),
    getAdminToolNames: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: { runInWorker: jest.fn() },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    addRunResult: jest.fn(),
    getScheduleById: jest.fn(),
    getSchedulesReadyToRun: jest.fn(),
    updateScheduleAfterRun: jest.fn(),
    setRunInFlight: jest.fn().mockResolvedValue(undefined),
    heartbeatRunInFlight: jest.fn().mockResolvedValue(undefined),
    clearRunInFlight: jest.fn().mockResolvedValue(true),
    getInFlightSchedules: jest.fn().mockResolvedValue([]),
    claimAbandonedRun: jest.fn().mockResolvedValue(true),
    updateSchedule: jest.fn(),
  },
  taskDb: {
    getTaskExecutionById: jest.fn(),
    createTaskExecution: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue({ userId: 'test-user-1', email: 'test@example.com', isAdmin: false }),
  },
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-run-id-123') }));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendScheduledChatResultEmail: jest.fn(),
    sendDailyDigestEmail: jest.fn(),
    sendScheduledChatVariableRequestEmail: jest.fn(),
    sendScheduledChatErrorEmail: jest.fn(),
    sendScheduledChatTokenLimitEmail: jest.fn(),
  },
}));

jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn(async () => ({
    allowed: true, warning: false, used: 1, allowance: 1000000,
    bonus: 0, effectiveAllowance: 1000000, percentUsed: 0, month: '2026-06',
  })),
}));

import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { scheduleDb } from '../services/db';
import { generateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { runScheduledChat, runVerifiedChat } from '../controllers/agentModeController';

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockAgentModeService = agentModeService as jest.Mocked<typeof agentModeService>;
const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockWorker = generateMarketingResponseWorkerService as jest.Mocked<typeof generateMarketingResponseWorkerService>;

// A lead-engagement-style schedule: no keywords, no required functions, no work plan.
// This is the exact shape that previously short-circuited to success on attempt 1.
const leadEngSchedule = {
  scheduleId: 'sched-lead-eng',
  scheduleName: 'Daily Event Lead Engagement Review',
  startingMessage: 'For each of the 3 events, research and report on every guest.',
  keywords: [],
  requiredFunctionCalls: [],
  userId: 'test-user-123',
};

const mockSession = {
  sessionId: 'test-session-123',
  userId: 'test-user-123',
  title: 'Scheduled: Daily Event Lead Engagement Review',
  sessionType: 'scheduled' as const,
  pageIdentifier: 'Scheduled: Daily Event Lead Engagement Review|scheduleId:sched-lead-eng',
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function workerResult(content: string) {
  return { content, toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
}

describe('runScheduledChat — deterministic completion gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChatbotDb.createChatSession.mockResolvedValue(mockSession as any);
    mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
    (mockChatbotDb as any).getMessagesFromMessagesTable.mockResolvedValue([]);
    mockChatbotDb.updateSessionLlmModel.mockResolvedValue(mockSession as any);
    mockChatbotDb.addMessageToSession.mockResolvedValue(mockSession as any);
    mockAgentModeService.getDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getScheduledChatsDefaultModel.mockResolvedValue('gpt-5-chat-2' as any);
    mockAgentModeService.getMarketingSystemPrompt.mockResolvedValue('System prompt' as any);
    mockAgentModeService.generateSessionTitle.mockResolvedValue('Title' as any);
    (mockAgentModeService as any).generateScheduledChatSummary.mockResolvedValue('Summary');
    mockScheduleDb.addRunResult.mockResolvedValue(undefined as any);
    mockScheduleDb.getScheduleById.mockResolvedValue(leadEngSchedule as any);
    mockScheduleDb.getSchedulesReadyToRun.mockResolvedValue([] as any);
    mockScheduleDb.updateScheduleAfterRun.mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('issues a continuation turn when the first turn admits unfinished work, then succeeds', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: admits it stopped short. Turn 2 (continuation): clean completion.
      return Promise.resolve(
        call === 1
          ? workerResult('Event 1 done. I did not complete Step 3 for Events 2 and 3.')
          : workerResult('All three events are now complete. Final consolidated report below.')
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Gate fired → at least 2 LLM turns (not the old single-turn short-circuit).
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Continuation message asks to finish remaining per-entity work.
    const secondMsg = mockWorker.runInWorker.mock.calls[1][0].messageContent as string;
    expect(secondMsg).toMatch(/not finished|remaining|complete all/i);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('ENG-244: issues a continuation when the run is truncated by the step budget, even with non-report partial text', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: step budget exhausted mid-gather. The model complied with the
      // "wrap up" nudge and wrote its own partial text (NO admission phrasing,
      // NO canned apology), but the run set truncatedByStepBudget. Turn 2
      // (continuation): produces the final report.
      return Promise.resolve(
        call === 1
          ? { ...workerResult('Here is a partial summary gathered so far; page 4 of the S3 export is still pending.'), truncatedByStepBudget: true }
          : workerResult('Daily User Activity Report complete. Final consolidated report below.')
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Gate fired off the flag → at least 2 LLM turns (no single-turn short-circuit).
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Continuation message is tailored to the truncation cause: it tells the model it
    // was cut off at its step budget and must NOT falsely claim it "indicated"
    // unfinished work (Greptile ENG-244 follow-up).
    const secondMsg = mockWorker.runInWorker.mock.calls[1][0].messageContent as string;
    expect(secondMsg).toMatch(/exhausted its processing-step budget|cut short/i);
    expect(secondMsg).not.toMatch(/indicated some entities\/steps were not finished/i);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('does NOT issue a continuation when the first turn is already complete', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResult('All three events completed. Consolidated report below.')
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Clean run → single turn, no gate continuation.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('does NOT loop on a legitimate per-entity blocker (no false continuation)', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResult("Event 2 — Bob: LinkedIn not connected, cannot view profile. All events covered; flagged as actionable.")
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('ENG-635: reports failure when the run still defers to the user after exhausting the completion gate', async () => {
    // Every turn punts the decision back to an absent human instead of delivering.
    // The gate issues its forceful "proceed best-effort, no human present" continuations,
    // but the model keeps deferring — so after the budget is exhausted the run must NOT
    // be reported as a clean success (it produced no deliverable).
    mockWorker.runInWorker.mockResolvedValue(
      workerResult("I found only 30 of the 100 requested ads. Should I proceed with cataloging the 30? Reply 'go' to proceed.")
    );

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Bounded: 1 initial + up to 2 continuations = 3, well under maxAttempts(20).
    const calls = mockWorker.runInWorker.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
    // Punted to an absent human and never delivered → recorded as a failure, not success.
    expect(result).toEqual(expect.objectContaining({ status: 'failure' }));
  });

  it('ENG-635: a persistent defer keeps runVerifiedChat success:true + flags deferredUnresolved (non-scheduled HTTP callers must not 500)', async () => {
    // Same persistent-defer scenario, but observed at the runVerifiedChat layer that
    // the HTTP callers (imageReports/revision/resultEndpoint) consume directly. They
    // key on `result.success`; a deliverable existed (requirements met), so success
    // MUST stay true — the defer is surfaced only via the `deferredUnresolved` flag,
    // which only the scheduled path turns into a failure.
    mockWorker.runInWorker.mockResolvedValue(
      workerResult("I found only 30 of the 100 requested ads. Should I proceed with cataloging the 30? Reply 'go' to proceed.")
    );

    const result = await runVerifiedChat({
      sessionId: 'test-session-123',
      userId: 'test-user-123',
      startingMessage: 'catalog ads',
      keywords: [],
      requiredFunctions: [],
      maxAttempts: 20,
      completionGate: true,
    });

    expect(result.success).toBe(true);
    expect((result as any).deferredUnresolved).toBe(true);
  });

  it('is bounded: stops after the max continuations even if it keeps admitting incompleteness', async () => {
    // Every turn admits incompleteness → gate must cap continuations, not loop to maxAttempts (20).
    mockWorker.runInWorker.mockResolvedValue(
      workerResult('I did not finish the remaining events yet.')
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // 1 initial + up to 2 continuations = 3. Must be well under maxAttempts(20).
    const calls = mockWorker.runInWorker.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });

  // ENG-518: the PER-LIST, result-aware preview→execute write-back gate, driven
  // end-to-end through the real runScheduledChat → runVerifiedChat loop (not just
  // the classifier). These prove the wiring: the loop accumulates the worker's
  // tool-call objects (name + arguments.list_id + result.processedCount) into
  // allToolCalls, feeds them to the gate, and the gate drives a continuation that
  // commits the write-back for every enrichable list that was not yet executed.
  const previewCall = (listId: string, processedCount: number) => ({
    name: 'enrich_leads_preview',
    arguments: { list_id: listId },
    result: { processedCount },
  });
  const executeCall = (listId: string) => ({
    name: 'enrich_leads_execute',
    arguments: { list_id: listId },
    result: { processedCount: 5 },
  });
  const workerResultWithTools = (content: string, toolCalls: any[]) => ({
    ...workerResult(content),
    toolCalls,
  });

  it('ENG-518: a run that previewed but never executed is driven to commit the write-back', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: previewed an enrichable list (processedCount > 0) and presented the
      // dry-run samples as if delivered — NO admission phrasing, NO confirmation
      // question, not truncated. The old text/flag-based gate saw nothing to
      // continue on. Turn 2 (continuation): the model calls the execute write-back.
      return Promise.resolve(
        call === 1
          ? workerResultWithTools(
              'Here are the enriched leads from the preview. Top prospects look strong.',
              [previewCall('list-1', 2)]
            )
          : workerResultWithTools(
              'Enrichment committed. Top 10 leads recommended and connection drafts below.',
              [executeCall('list-1')]
            )
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // Gate fired on the tool-call fact (enrichable preview without execute) → 2nd turn.
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondMsg = mockWorker.runInWorker.mock.calls[1][0].messageContent as string;
    expect(secondMsg).toMatch(/enrich_leads_execute/);
    expect(secondMsg).toMatch(/never committed|write-back/i);
    // The continuation CONSULTS the task's intent (Greptile #2): commit if the task
    // asked to enrich, but do NOT write if it explicitly asked for a preview only.
    expect(secondMsg).toMatch(/if the task asked you to ENRICH/i);
    expect(secondMsg).toMatch(/EXPLICITLY asked to preview/i);
    // Once execute ran for the list, the gap is closed and the run succeeds.
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('ENG-518: a partial multi-list run keeps firing until every enrichable list is committed', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: previewed 2 enrichable lists but executed only list-1 → list-2 still
      // uncommitted (the Greptile partial-write-back gap). Turn 2: commits list-2.
      return Promise.resolve(
        call === 1
          ? workerResultWithTools('Enriched list-1; list-2 samples below.', [
              previewCall('list-1', 2), previewCall('list-2', 2), executeCall('list-1'),
            ])
          : workerResultWithTools('list-2 committed. Final report below.', [executeCall('list-2')])
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // A subset-execute must NOT close the gate — it fires again for list-2.
    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('ENG-518: a failed execute (error) does NOT close the gate — it retries until write-back lands', async () => {
    let call = 0;
    mockWorker.runInWorker.mockImplementation(() => {
      call++;
      // Turn 1: previewed enrichable list-1 and attempted execute, but it threw →
      // the write-back never landed. The gate must NOT treat the errored execute as
      // done. Turn 2 (continuation): execute succeeds and the run finishes.
      return Promise.resolve(
        call === 1
          ? workerResultWithTools('Previewed list-1; the execute call errored out.', [
              previewCall('list-1', 2),
              { name: 'enrich_leads_execute', arguments: { list_id: 'list-1' }, error: 'engine timeout' },
            ])
          : workerResultWithTools('Execute succeeded on retry. Final report below.', [executeCall('list-1')])
      );
    });

    const result = await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    expect(mockWorker.runInWorker.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toEqual(expect.objectContaining({ status: 'success' }));
  });

  it('ENG-518: a run that previewed AND executed the same list does NOT fire the gate', async () => {
    mockWorker.runInWorker.mockResolvedValue(
      workerResultWithTools('Enrichment previewed and committed. Recommendations and drafts below.', [
        previewCall('list-1', 2), executeCall('list-1'),
      ])
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // The list's execute counterpart already ran → no continuation.
    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('ENG-518: an UNENRICHABLE preview (processedCount 0) is not forced to execute', async () => {
    // The engine resolved nobody for this list; the model correctly skipped execute.
    // The gate must NOT chase it (no unauthorized CRM write, no loop) → single turn.
    mockWorker.runInWorker.mockResolvedValue(
      workerResultWithTools('This list is unenrichable — surfaced as an actionable gap.', [
        previewCall('list-1', 0),
      ])
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    expect(mockWorker.runInWorker).toHaveBeenCalledTimes(1);
  });

  it('ENG-518: keeps chasing the write-back but stays bounded if execute never runs', async () => {
    // Every turn previews an enrichable list without executing → the gate must keep
    // firing (the gap is still open) yet remain capped by completionGateMaxContinuations.
    mockWorker.runInWorker.mockResolvedValue(
      workerResultWithTools('Preview samples shown above.', [previewCall('list-1', 2)])
    );

    await runScheduledChat(leadEngSchedule, 'test-user-123', true);

    // 1 initial + up to 2 continuations = 3. Bounded well under maxAttempts(20).
    const calls = mockWorker.runInWorker.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
  });
});
