/**
 * Tests for chatbotDb.updateSessionWorkflowRun (ENG-397) — the persistence
 * seam for the Workflow engine's run state.
 *
 * Like chatbotService.askUserQuestion.test.ts, these exercise the REAL method
 * body by spying on the exported DynamoDB client, so the SET vs REMOVE
 * branches, the guard ConditionExpression, and error propagation are actually
 * covered rather than mocked away — the mocked-chatbotDb tests in
 * agentModeWorkflowEngine.metaCreateCampaign.test.ts never exercise this
 * method's own body at all.
 */

import { chatbotDb, dynamodb } from '../services/chatbotService';
import { buildWorkflowRunState, type WorkflowRunState } from '../services/agentMode/core/workflow';

function sampleRun(): WorkflowRunState {
  return buildWorkflowRunState({ runId: 'run-1', workflowId: 'wf-1', createdAt: '2026-01-01T00:00:00.000Z' });
}

describe('chatbotDb.updateSessionWorkflowRun', () => {
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SETs the workflow run when one is provided', async () => {
    const run = sampleRun();
    await chatbotDb.updateSessionWorkflowRun('s-1', run);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const params = updateSpy.mock.calls[0][0];
    expect(params.Key).toEqual({ sessionId: 's-1' });
    expect(params.UpdateExpression).toMatch(/SET workflowRun = :workflowRun/);
    expect(params.ExpressionAttributeValues[':workflowRun']).toEqual(run);
    expect(params.ExpressionAttributeValues[':adminListPartition']).toBe('all');
    expect(params.ReturnValues).toBe('ALL_NEW');
  });

  it('REMOVEs the workflow run when null is provided', async () => {
    await chatbotDb.updateSessionWorkflowRun('s-1', null);

    const params = updateSpy.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('REMOVE workflowRun');
    expect(params.ReturnValues).toBe('ALL_NEW');
  });

  it('returns the updated session attributes', async () => {
    const result = await chatbotDb.updateSessionWorkflowRun('s-1', sampleRun());
    expect(result).toEqual({ sessionId: 's-1' });
  });

  it('propagates DynamoDB errors', async () => {
    updateSpy.mockReturnValue({ promise: () => Promise.reject(new Error('DynamoDB unavailable')) } as any);
    await expect(chatbotDb.updateSessionWorkflowRun('s-1', sampleRun())).rejects.toThrow('DynamoDB unavailable');
  });

  it('does NOT add a ConditionExpression on a plain unguarded write', async () => {
    await chatbotDb.updateSessionWorkflowRun('s-1', sampleRun());
    expect(updateSpy.mock.calls[0][0].ConditionExpression).toBeUndefined();
  });

  // The load-bearing fix: attribute_not_exists(workflowRun) alone is
  // satisfied identically whether the field is merely absent on an EXISTING
  // session or the whole session item doesn't exist at all — DynamoDB's
  // conditional UpdateItem creates the item if missing. Without
  // attribute_exists(sessionId) in the same condition, a caller racing a
  // session deletion (or skipping its own pre-check) would silently upsert a
  // partial ChatSession row instead of failing the guard.
  it('requires attribute_exists(sessionId) in the same condition as failIfActiveExists, so it cannot upsert a missing/deleted session', async () => {
    await chatbotDb.updateSessionWorkflowRun('s-1', sampleRun(), { failIfActiveExists: true });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toMatch(/^attribute_exists\(sessionId\) AND \(/);
    expect(params.ConditionExpression).toMatch(
      /attribute_not_exists\(workflowRun\) OR workflowRun\.#wStatus IN \(:completedStatus, :failedStatus\)/,
    );
    expect(params.ExpressionAttributeNames['#wStatus']).toBe('status');
    expect(params.ExpressionAttributeValues[':completedStatus']).toBe('completed');
    expect(params.ExpressionAttributeValues[':failedStatus']).toBe('failed');
  });

  it('adds the version-lock ConditionExpression when requireVersion is set', async () => {
    const run = sampleRun();
    await chatbotDb.updateSessionWorkflowRun('s-1', run, { requireVersion: run.version });
    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toBe('workflowRun.runId = :requireRunId AND workflowRun.version = :requireVersion');
    expect(params.ExpressionAttributeValues[':requireRunId']).toBe(run.runId);
    expect(params.ExpressionAttributeValues[':requireVersion']).toBe(run.version);
  });

  it('returns null (refuses) on a conditional check failure, for the guarded write', async () => {
    updateSpy.mockReturnValue({
      promise: () => Promise.reject(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' })),
    } as any);
    const res = await chatbotDb.updateSessionWorkflowRun('s-1', sampleRun(), { failIfActiveExists: true });
    expect(res).toBeNull();
  });

  it('returns null (refuses) on a conditional check failure, for the version-locked write', async () => {
    const run = sampleRun();
    updateSpy.mockReturnValue({
      promise: () => Promise.reject(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' })),
    } as any);
    const res = await chatbotDb.updateSessionWorkflowRun('s-1', run, { requireVersion: run.version });
    expect(res).toBeNull();
  });

  it('still propagates non-conditional DynamoDB errors even when guarded', async () => {
    updateSpy.mockReturnValue({ promise: () => Promise.reject(new Error('DynamoDB unavailable')) } as any);
    await expect(
      chatbotDb.updateSessionWorkflowRun('s-1', sampleRun(), { failIfActiveExists: true }),
    ).rejects.toThrow('DynamoDB unavailable');
  });
});
