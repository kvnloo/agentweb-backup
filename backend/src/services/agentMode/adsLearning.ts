/** Optional observer; execution success/failure and response remain owned by the existing path. */
export async function recordCreativeLearningReceipt(userId: string, accountId: string, adId: string, creativeId: string, verified: boolean): Promise<void> {
  try {
    const { observeVerifiedCreativeExecution } = await import('../adsExecutionCapture');
    await observeVerifiedCreativeExecution({ userId, accountId, adId, creativeId, verified, now: new Date().toISOString() });
  } catch { console.error('[AdsLearning] execution receipt unavailable'); }
}
