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
  let getSpy: jest.SpyInstance;

  beforeEach(() => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);
    // Default: no existing pendingUserQuestion, so the archiving pre-read is a
    // no-op and every pre-existing test below sees the SAME UpdateExpression
    // shape as before this pre-read was introduced (ENG-400).
    getSpy = jest.spyOn(dynamodb, 'get').mockReturnValue({
      promise: () => Promise.resolve({ Item: undefined }),
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

  // ENG-396: the one-live-question invariant. A new AWAITING question may only be
  // posed when none is already awaiting — enforced atomically via a conditional
  // write so two ask_user_question calls in the same turn can't both take the slot.
  it('does NOT add a ConditionExpression on the normal (unguarded) write', async () => {
    await chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion());
    expect(updateSpy.mock.calls[0][0].ConditionExpression).toBeUndefined();
  });

  it('guards against overwriting an awaiting question when failIfAwaitingExists is set', async () => {
    await chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion(), { failIfAwaitingExists: true });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toMatch(
      /attribute_not_exists\(pendingUserQuestion\) OR pendingUserQuestion\.#pStatus <> :awaitingStatus/,
    );
    expect(params.ExpressionAttributeNames['#pStatus']).toBe('status');
    expect(params.ExpressionAttributeValues[':awaitingStatus']).toBe('awaiting');
  });

  it('returns null (refuses) when a question is already awaiting — conditional write fails', async () => {
    updateSpy.mockReturnValue({
      promise: () =>
        Promise.reject(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' })),
    } as any);

    const res = await chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion(), {
      failIfAwaitingExists: true,
    });
    expect(res).toBeNull();
  });

  it('still propagates non-conditional DynamoDB errors even when guarded', async () => {
    updateSpy.mockReturnValue({
      promise: () => Promise.reject(new Error('DynamoDB unavailable')),
    } as any);

    await expect(
      chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion(), { failIfAwaitingExists: true }),
    ).rejects.toThrow('DynamoDB unavailable');
  });

  // ── ENG-400: archiving the live slot before it's replaced ────────────────
  describe('answer archiving (multi-question generalization)', () => {
    it('archives the current ANSWERED question under its id when a different new question is posted', async () => {
      const current: PendingUserQuestion = { ...sampleQuestion(), questionId: 'q-old', status: 'answered', answer: { optionId: 'leads', delegated: false, answeredBy: 'user', at: '2026-07-21T00:01:00.000Z' } };
      getSpy.mockReturnValue({ promise: () => Promise.resolve({ Item: { pendingUserQuestion: current } }) } as any);

      const next = { ...sampleQuestion(), questionId: 'q-new' };
      await chatbotDb.updateSessionAskUserQuestion('s-1', next);

      const params = updateSpy.mock.calls[0][0];
      expect(params.UpdateExpression).toMatch(/answeredQuestions = :answeredQuestions/);
      expect(params.ExpressionAttributeValues[':answeredQuestions']).toEqual({ 'q-old': current });
      expect(params.ExpressionAttributeValues[':pendingUserQuestion']).toEqual(next);
    });

    it('merges into an existing answeredQuestions archive rather than overwriting it', async () => {
      const priorArchive = { 'q-ancient': { ...sampleQuestion(), questionId: 'q-ancient', status: 'answered' as const } };
      const current: PendingUserQuestion = { ...sampleQuestion(), questionId: 'q-old', status: 'answered', answer: { optionId: 'leads', delegated: false, answeredBy: 'user', at: '2026-07-21T00:01:00.000Z' } };
      getSpy.mockReturnValue({
        promise: () => Promise.resolve({ Item: { pendingUserQuestion: current, answeredQuestions: priorArchive } }),
      } as any);

      await chatbotDb.updateSessionAskUserQuestion('s-1', { ...sampleQuestion(), questionId: 'q-new' });

      const params = updateSpy.mock.calls[0][0];
      expect(params.ExpressionAttributeValues[':answeredQuestions']).toEqual({
        ...priorArchive,
        'q-old': current,
      });
    });

    it('does NOT archive when the current live slot is still AWAITING (nothing worth keeping)', async () => {
      const current: PendingUserQuestion = { ...sampleQuestion(), questionId: 'q-old', status: 'awaiting' };
      getSpy.mockReturnValue({ promise: () => Promise.resolve({ Item: { pendingUserQuestion: current } }) } as any);

      await chatbotDb.updateSessionAskUserQuestion('s-1', { ...sampleQuestion(), questionId: 'q-new' });

      const params = updateSpy.mock.calls[0][0];
      expect(params.UpdateExpression).not.toMatch(/answeredQuestions/);
      expect(params.ExpressionAttributeValues[':answeredQuestions']).toBeUndefined();
    });

    it('does NOT archive when re-posting the SAME questionId (not a rollover)', async () => {
      const current: PendingUserQuestion = { ...sampleQuestion(), questionId: 'q-1', status: 'answered', answer: { optionId: 'leads', delegated: false, answeredBy: 'user', at: '2026-07-21T00:01:00.000Z' } };
      getSpy.mockReturnValue({ promise: () => Promise.resolve({ Item: { pendingUserQuestion: current } }) } as any);

      await chatbotDb.updateSessionAskUserQuestion('s-1', sampleQuestion()); // same questionId 'q-1'

      const params = updateSpy.mock.calls[0][0];
      expect(params.UpdateExpression).not.toMatch(/answeredQuestions/);
    });

    it('does NOT read/archive on a REMOVE (null) write', async () => {
      await chatbotDb.updateSessionAskUserQuestion('s-1', null);
      expect(getSpy).not.toHaveBeenCalled();
    });
  });
});
