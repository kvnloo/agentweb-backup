// ENG-1644 Phase D / ENG-1853: unit tests for approvalInboxExecution.ts —
// what "executing" a resolved decision means per gate type. ENG-1853
// replaced the old passive-only notify with a real active resume
// (generateSessionResponse), falling back to the old passive note only when
// the resume genuinely can't run — these tests cover both paths, not just
// the fallback.

jest.mock('../services/chatbotService', () => ({
  chatbotDb: { addMessageToSession: jest.fn(), getChatSessionRecord: jest.fn() },
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { recordExecutionResult: jest.fn(), markDispatching: jest.fn() },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { getDefaultModel: jest.fn().mockResolvedValue('gpt-5-chat-2') },
}));

const mockIoEmit = jest.fn();
const mockIoTo = jest.fn().mockReturnValue({ emit: mockIoEmit });
jest.mock('../server', () => ({ io: { to: mockIoTo } }));

jest.mock('../controllers/agentModeController', () => ({
  generateSessionResponse: jest.fn(),
  tryClaimSessionGeneration: jest.fn(),
  releaseSessionGeneration: jest.fn(),
}));

import { chatbotDb } from '../services/chatbotService';
import { approvalInboxService } from '../services/approvalInboxService';
import {
  generateSessionResponse,
  tryClaimSessionGeneration,
  releaseSessionGeneration,
} from '../controllers/agentModeController';
import { executeResolvedDecision, notifyOriginSessionOfExpiry } from '../services/approvalInboxExecution';

const mockAddMessage = chatbotDb.addMessageToSession as jest.Mock;
const mockGetSessionRecord = chatbotDb.getChatSessionRecord as jest.Mock;
const mockRecordExecutionResult = approvalInboxService.recordExecutionResult as jest.Mock;
const mockMarkDispatching = approvalInboxService.markDispatching as jest.Mock;
const mockGenerateSessionResponse = generateSessionResponse as jest.Mock;
const mockTryClaimSessionGeneration = tryClaimSessionGeneration as jest.Mock;
const mockReleaseSessionGeneration = releaseSessionGeneration as jest.Mock;

const activeSession = { sessionId: 'sess-1', userId: 'user-1', llmModel: 'gpt-5-chat-2' };

describe('executeResolvedDecision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddMessage.mockResolvedValue({});
    mockRecordExecutionResult.mockResolvedValue(undefined);
    mockMarkDispatching.mockResolvedValue(undefined);
    mockGetSessionRecord.mockResolvedValue(activeSession);
    mockTryClaimSessionGeneration.mockReturnValue(true);
    mockGenerateSessionResponse.mockResolvedValue({ content: 'Done — proceeding with the resolved answer.' });
  });

  const baseDecision: any = {
    decisionId: 'd1',
    gateType: 'plan_choice',
    audience: 'team',
    approver: 'matt',
    businessImpact: 'Decides the ad set strategy.',
    verdict: 'approve',
    answeredBy: 'matt',
    answeredAt: '2026-09-24T10:00:00.000Z',
    originSessionId: 'sess-1',
  };

  it('meta_write only marks the item dispatching — never resumes, never notifies, never records a terminal outcome here', async () => {
    await executeResolvedDecision({ ...baseDecision, gateType: 'meta_write' });

    expect(mockMarkDispatching).toHaveBeenCalledWith('d1');
    expect(mockGenerateSessionResponse).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockRecordExecutionResult).not.toHaveBeenCalled();
  });

  it('meta_write reject/edit verdicts never mark dispatching — only approve does', async () => {
    await executeResolvedDecision({ ...baseDecision, gateType: 'meta_write', verdict: 'reject' });
    await executeResolvedDecision({ ...baseDecision, gateType: 'meta_write', verdict: 'edit', freeText: 'lower the budget' });

    expect(mockMarkDispatching).not.toHaveBeenCalled();
  });

  it('plan_choice approve: actively resumes the origin session (not just a passive note) and records executed', async () => {
    await executeResolvedDecision(baseDecision);

    expect(mockTryClaimSessionGeneration).toHaveBeenCalledWith('sess-1', 'user-1');
    expect(mockGenerateSessionResponse).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('matt approved this decision'),
      'user-1',
      'gpt-5-chat-2',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'approval-inbox-resolution',
    );
    expect(mockReleaseSessionGeneration).toHaveBeenCalledWith('sess-1');
    // A real resume never ALSO writes the old passive note — one record of
    // the event, not two.
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('pushes the resumed turn to a live-connected client via socket, same as auto-continuation', async () => {
    await executeResolvedDecision(baseDecision);

    expect(mockIoTo).toHaveBeenCalledWith('user:user-1');
    expect(mockIoEmit).toHaveBeenCalledWith('session-message-appended', expect.objectContaining({
      sessionId: 'sess-1',
      message: expect.objectContaining({ role: 'assistant', content: 'Done — proceeding with the resolved answer.' }),
    }));
  });

  it('falls back to a passive note when the origin session cannot be found', async () => {
    mockGetSessionRecord.mockResolvedValue(null);

    await executeResolvedDecision(baseDecision);

    expect(mockGenerateSessionResponse).not.toHaveBeenCalled();
    expect(mockAddMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('matt approved this decision'),
    }));
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('falls back to a passive note when a real user turn is already generating on this session (never fights a live turn)', async () => {
    mockTryClaimSessionGeneration.mockReturnValue(false);

    await executeResolvedDecision(baseDecision);

    expect(mockGenerateSessionResponse).not.toHaveBeenCalled();
    expect(mockReleaseSessionGeneration).not.toHaveBeenCalled(); // never claimed, never releases
    expect(mockAddMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      content: expect.stringContaining('matt approved this decision'),
    }));
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('falls back to a passive note when generateSessionResponse itself throws — still records executed, not execution_failed', async () => {
    mockGenerateSessionResponse.mockRejectedValue(new Error('worker crashed'));

    await executeResolvedDecision(baseDecision);

    expect(mockReleaseSessionGeneration).toHaveBeenCalledWith('sess-1'); // still released even on throw
    expect(mockAddMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      content: expect.stringContaining('matt approved this decision'),
    }));
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('humanizes a system:<reason> answeredBy instead of echoing the raw internal tag (review fix)', async () => {
    mockGetSessionRecord.mockResolvedValue(null); // exercise via the passive-note content path
    await executeResolvedDecision({ ...baseDecision, answeredBy: 'system:auto-reconnect', gateType: 'customer_credential', audience: 'customer', approver: undefined });

    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('the system automatically (auto reconnect) approved this decision');
    expect(call.content).not.toContain('system:auto-reconnect');
  });

  it('reject verdict still resumes the origin session (not just approve)', async () => {
    await executeResolvedDecision({ ...baseDecision, verdict: 'reject' });

    expect(mockGenerateSessionResponse).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('rejected this decision'),
      expect.anything(), expect.anything(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'approval-inbox-resolution',
    );
  });

  it('edit verdict includes the correction note and a do-not-proceed directive', async () => {
    mockGetSessionRecord.mockResolvedValue(null); // exercise via the passive-note content path
    await executeResolvedDecision({ ...baseDecision, verdict: 'edit', freeText: 'Use a shorter headline.' });

    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('sent back with a correction');
    expect(call.content).toContain('Use a shorter headline.');
    expect(call.content).toContain('Do not proceed with the original plan as-is');
  });

  it('no originSessionId: skips both resume and notify, still records executed', async () => {
    await executeResolvedDecision({ ...baseDecision, originSessionId: undefined });

    expect(mockGetSessionRecord).not.toHaveBeenCalled();
    expect(mockGenerateSessionResponse).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('a total failure (both active resume AND its passive-note fallback fail) records execution_failed rather than throwing', async () => {
    mockGetSessionRecord.mockRejectedValue(new Error('DynamoDB down'));
    mockAddMessage.mockRejectedValue(new Error('Session not found'));

    await expect(executeResolvedDecision(baseDecision)).resolves.toBeUndefined();

    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'execution_failed', expect.objectContaining({
      success: false,
      message: 'Session not found',
    }));
  });

  it('never throws even when recordExecutionResult itself fails', async () => {
    mockRecordExecutionResult.mockRejectedValue(new Error('DynamoDB unavailable'));

    await expect(executeResolvedDecision(baseDecision)).resolves.toBeUndefined();
  });
});

describe('notifyOriginSessionOfExpiry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddMessage.mockResolvedValue({});
  });

  const expiredDecision: any = {
    decisionId: 'd1',
    gateType: 'plan_choice',
    audience: 'team',
    approver: 'matt',
    businessImpact: 'Decides the ad set strategy.',
    status: 'expired',
    originSessionId: 'sess-1',
  };

  it('notifies the origin session with an explicit expired/nobody-answered message', async () => {
    await notifyOriginSessionOfExpiry(expiredDecision);

    expect(mockAddMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('expired with no answer'),
    }));
    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('Do not assume this was approved or rejected');
    expect(call.metadata.kind).toBe('approval-inbox-resolution');
  });

  it('names the approver when audience is team', async () => {
    await notifyOriginSessionOfExpiry(expiredDecision);
    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('from matt');
  });

  it('says "the customer" when audience is customer and there is no approver', async () => {
    await notifyOriginSessionOfExpiry({ ...expiredDecision, audience: 'customer', approver: undefined });
    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('from the customer');
  });

  it('no originSessionId: skips the notify entirely', async () => {
    await notifyOriginSessionOfExpiry({ ...expiredDecision, originSessionId: undefined });
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('a notify failure is swallowed — never throws', async () => {
    mockAddMessage.mockRejectedValue(new Error('Session not found'));
    await expect(notifyOriginSessionOfExpiry(expiredDecision)).resolves.toBeUndefined();
  });
});
