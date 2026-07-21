/**
 * Tests for chatbotDb.updateSessionAskUserQuestion (ENG-396) — the persistence
 * seam that lets the AskUserQuestion answer be read structurally by the next
 * tool call (never re-parsed from prose) and lets an unanswered gate survive as
 * a parked pending_user_input state.
 *
 * Unlike chatbotService.workPlan.test.ts (which mocks the whole method), these
 * exercise the REAL method body by spying on the exported DynamoDB client, so
 * the SET vs REMOVE branches and error propagation are actually covered.
 */

import { chatbotDb, dynamodb } from '../services/chatbotService';
import { buildPendingUserQuestion, type PendingUserQuestion } from '../services/agentMode/core/askUserQuestion';

function sampleQuestion(): PendingUserQuestion {
  return buildPendingUserQuestion({
    questionId: 'q-1',
    question: 'Which Meta campaign objective? It cannot be changed after launch.',
    options: [
      {
        id: 'leads',
        label: 'Leads',
        consequence: 'Optimizes for booked demos.',
        recommended: true,
        why: '162 LEAD events in the last 30d.',
        payload: { objective: 'OUTCOME_LEADS' },
      },
      { id: 'traffic', label: 'Traffic', consequence: 'Optimizes for visits, not leads.' },
    ],
    immutable: true,
    allowEmmaDecide: true,
    createdAt: '2026-07-21T00:00:00.000Z',
  });
}

describe('chatbotDb.updateSessionAskUserQuestion', () => {
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SETs the pending question when one is provided', async () => {
    const q = sampleQuestion();
    await chatbotDb.updateSessionAskUserQuestion('s-1', q);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const params = updateSpy.mock.calls[0][0];
    expect(params.Key).toEqual({ sessionId: 's-1' });
    expect(params.UpdateExpression).toMatch(/SET pendingUserQuestion = :pendingUserQuestion/);
    expect(params.ExpressionAttributeValues[':pendingUserQuestion']).toEqual(q);
    // keeps the admin list partition consistent, like the other writers
    expect(params.ExpressionAttributeValues[':adminListPartition']).toBe('all');
    expect(params.ReturnValues).toBe('ALL_NEW');
  });

  it('REMOVEs the pending question when null is provided', async () => {
    await chatbotDb.updateSessionAskUserQuestion('s-1', null);

    const params = updateSpy.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('REMOVE pendingUserQuestion');
    expect(params.ExpressionAttributeValues).toBeUndefined();
    expect(params.ReturnValues).toBe('ALL_NEW');
  });

  it('returns the updated session attributes', async () => {
    const result = await chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion());
    expect(result).toEqual({ sessionId: 's-1' });
  });

  it('propagates DynamoDB errors', async () => {
    updateSpy.mockReturnValue({
      promise: () => Promise.reject(new Error('DynamoDB unavailable')),
    } as any);

    await expect(chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion())).rejects.toThrow(
      'DynamoDB unavailable',
    );
  });
});
