// ENG-1644 Phase D: unit tests for approvalInboxExecution.ts — what
// "executing" a resolved decision means per gate type.

jest.mock('../services/chatbotService', () => ({
  chatbotDb: { addMessageToSession: jest.fn() },
}));

jest.mock('../services/approvalInboxService', () => ({
  approvalInboxService: { recordExecutionResult: jest.fn() },
}));

import { chatbotDb } from '../services/chatbotService';
import { approvalInboxService } from '../services/approvalInboxService';
import { executeResolvedDecision, notifyOriginSessionOfExpiry } from '../services/approvalInboxExecution';

const mockAddMessage = chatbotDb.addMessageToSession as jest.Mock;
const mockRecordExecutionResult = approvalInboxService.recordExecutionResult as jest.Mock;

describe('executeResolvedDecision', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddMessage.mockResolvedValue({});
    mockRecordExecutionResult.mockResolvedValue(undefined);
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

  it('meta_write is a recorded no-op — never dispatches, never notifies', async () => {
    await executeResolvedDecision({ ...baseDecision, gateType: 'meta_write' });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockRecordExecutionResult).toHaveBeenCalledWith(
      'd1',
      'execution_failed',
      expect.objectContaining({ success: false, message: expect.stringContaining('not implemented') }),
    );
  });

  it('plan_choice approve: notifies the origin session and records executed', async () => {
    await executeResolvedDecision(baseDecision);

    expect(mockAddMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      role: 'system',
      content: expect.stringContaining('matt approved this decision'),
    }));
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('humanizes a system:<reason> answeredBy instead of echoing the raw internal tag (review fix)', async () => {
    await executeResolvedDecision({ ...baseDecision, answeredBy: 'system:auto-reconnect', gateType: 'customer_credential', audience: 'customer', approver: undefined });

    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('the system automatically (auto reconnect) approved this decision');
    expect(call.content).not.toContain('system:auto-reconnect');
  });

  it('reject verdict still notifies the origin session (not just approve)', async () => {
    await executeResolvedDecision({ ...baseDecision, verdict: 'reject' });

    expect(mockAddMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      content: expect.stringContaining('rejected this decision'),
    }));
  });

  it('edit verdict includes the correction note and a do-not-proceed directive', async () => {
    await executeResolvedDecision({ ...baseDecision, verdict: 'edit', freeText: 'Use a shorter headline.' });

    const call = mockAddMessage.mock.calls[0][1];
    expect(call.content).toContain('sent back with a correction');
    expect(call.content).toContain('Use a shorter headline.');
    expect(call.content).toContain('Do not proceed with the original plan as-is');
  });

  it('no originSessionId: skips the notify, still records executed', async () => {
    await executeResolvedDecision({ ...baseDecision, originSessionId: undefined });

    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockRecordExecutionResult).toHaveBeenCalledWith('d1', 'executed', expect.objectContaining({ success: true }));
  });

  it('a notify failure records execution_failed rather than throwing', async () => {
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
