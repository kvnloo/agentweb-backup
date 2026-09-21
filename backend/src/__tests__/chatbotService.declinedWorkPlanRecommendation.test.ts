/**
 * ENG-1974 — chatbotDb.recordDeclinedWorkPlanRecommendation
 *
 * Records that the user declined a workplan recommendation via "Keep chatting". Mirrors
 * claimMetaWriteManifestDigest's "SET the map key, and on ValidationException init the map
 * then retry once" shape, but as an UNCONDITIONAL overwrite — re-declining the same
 * recommendationId is harmless and idempotent, unlike a Meta-write claim which must stay
 * exactly-once. Same spy-on-dynamodb.update pattern as
 * chatbotService.workPlanInputRequest.test.ts, so this exercises the real write-helper logic,
 * not a mocked chatbotDb.
 */
import { chatbotDb, dynamodb } from '../services/chatbotService';

const entry = { planId: 'plan-onboard', planTitle: 'Client Onboarding', declinedAt: '2026-09-17T00:00:00.000Z' };

describe('chatbotDb.recordDeclinedWorkPlanRecommendation', () => {
  let updateSpy: jest.SpyInstance;

  afterEach(() => jest.restoreAllMocks());

  it('sets the declined entry at the recommendationId map key on the happy path', async () => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);

    const result = await chatbotDb.recordDeclinedWorkPlanRecommendation('s-1', 'reco-abc', entry);

    expect(result).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const params = updateSpy.mock.calls[0][0];
    expect(params.UpdateExpression).toBe('SET declinedWorkPlanRecommendations.#id = :entry');
    expect(params.ExpressionAttributeNames).toEqual({ '#id': 'reco-abc' });
    expect(params.ExpressionAttributeValues).toEqual({ ':entry': entry });
  });

  it('re-declining the same recommendationId is an unconditional overwrite, not a claim — no ConditionExpression on the map key itself', async () => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }),
    } as any);

    await chatbotDb.recordDeclinedWorkPlanRecommendation('s-1', 'reco-abc', entry);

    const params = updateSpy.mock.calls[0][0];
    // Only guards the session existing — never attribute_not_exists on the map
    // key, unlike claimMetaWriteManifestDigest's exactly-once claim.
    expect(params.ConditionExpression).toBe('attribute_exists(sessionId)');
  });

  it('initializes the map then retries once on ValidationException (fresh session, no declinedWorkPlanRecommendations attribute yet)', async () => {
    updateSpy = jest
      .spyOn(dynamodb, 'update')
      // First call: SET declinedWorkPlanRecommendations.#id — fails because the map attribute doesn't exist.
      .mockReturnValueOnce({ promise: () => Promise.reject({ code: 'ValidationException' }) } as any)
      // Second call: initialize the empty map.
      .mockReturnValueOnce({ promise: () => Promise.resolve({}) } as any)
      // Third call: the retry, now succeeds.
      .mockReturnValueOnce({ promise: () => Promise.resolve({ Attributes: { sessionId: 's-1' } }) } as any);

    const result = await chatbotDb.recordDeclinedWorkPlanRecommendation('s-1', 'reco-abc', entry);

    expect(result).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(3);
    const initParams = updateSpy.mock.calls[1][0];
    expect(initParams.UpdateExpression).toBe(
      'SET declinedWorkPlanRecommendations = if_not_exists(declinedWorkPlanRecommendations, :empty)',
    );
    const retryParams = updateSpy.mock.calls[2][0];
    expect(retryParams.UpdateExpression).toBe('SET declinedWorkPlanRecommendations.#id = :entry');
  });

  it('returns false when the session does not exist (ConditionalCheckFailedException)', async () => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.reject({ code: 'ConditionalCheckFailedException' }),
    } as any);

    const result = await chatbotDb.recordDeclinedWorkPlanRecommendation('nonexistent-session', 'reco-abc', entry);

    expect(result).toBe(false);
  });

  it('returns false when the session is deleted between the ValidationException and the map-init retry', async () => {
    updateSpy = jest
      .spyOn(dynamodb, 'update')
      .mockReturnValueOnce({ promise: () => Promise.reject({ code: 'ValidationException' }) } as any)
      .mockReturnValueOnce({ promise: () => Promise.reject({ code: 'ConditionalCheckFailedException' }) } as any);

    const result = await chatbotDb.recordDeclinedWorkPlanRecommendation('s-1', 'reco-abc', entry);

    expect(result).toBe(false);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('rethrows an unexpected error', async () => {
    updateSpy = jest.spyOn(dynamodb, 'update').mockReturnValue({
      promise: () => Promise.reject(new Error('boom')),
    } as any);

    await expect(chatbotDb.recordDeclinedWorkPlanRecommendation('s-1', 'reco-abc', entry)).rejects.toThrow('boom');
  });
});
