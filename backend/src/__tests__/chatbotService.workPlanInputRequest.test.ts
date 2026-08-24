import { chatbotDb, dynamodb } from '../services/chatbotService';
import { buildWorkPlanInputRequest } from '../services/agentMode/core/workPlanInputRequest';

const request = () => buildWorkPlanInputRequest({
  requestId: 'request-1', stepCount: 1, title: 'Event details', prompt: 'Enter event details.',
  fields: [{ id: 'guest_list_url', label: 'Guest list URL', type: 'url', required: true }],
  createdAt: '2026-08-20T00:00:00.000Z',
});

describe('chatbotDb.updateSessionWorkPlanInputRequest', () => {
  let updateSpy: jest.SpyInstance;

  beforeEach(() => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('persists a pending request without replacing the existing question slot', async () => {
    await chatbotDb.updateSessionWorkPlanInputRequest('s-1', request());

    const params = updateSpy.mock.calls[0][0];
    expect(params.UpdateExpression).toContain('SET pendingWorkPlanInput = :pendingWorkPlanInput');
    expect(params.UpdateExpression).not.toContain('pendingUserQuestion =');
    expect(params.ExpressionAttributeValues[':pendingWorkPlanInput']).toEqual(request());
  });

  it('atomically refuses a second open input request or an open question', async () => {
    await chatbotDb.updateSessionWorkPlanInputRequest('s-1', request(), { failIfAwaitingExists: true });

    const params = updateSpy.mock.calls[0][0];
    expect(params.ConditionExpression).toContain('attribute_not_exists(pendingWorkPlanInput)');
    expect(params.ConditionExpression).toContain('attribute_not_exists(pendingUserQuestion)');
  });

  it('removes only the pending work-plan request when the step consumes it', async () => {
    await chatbotDb.updateSessionWorkPlanInputRequest('s-1', null);
    expect(updateSpy.mock.calls[0][0].UpdateExpression).toBe('REMOVE pendingWorkPlanInput');
  });
});
