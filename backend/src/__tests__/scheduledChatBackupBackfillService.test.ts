import { planScheduleBackupBackfill } from '../services/scheduledChatBackupBackfillService';

const policy = {
  version: 'pro-v1',
  enforcementState: 'enforce' as const,
  optimizationCostThresholdMicroUsd: 80_000_000,
  hardCostThresholdMicroUsd: 150_000_000,
  optimizedModelIds: ['gemini-3.1-flash-lite'],
  optimizedDefaultModel: 'gemini-3.1-flash-lite',
};

describe('planScheduleBackupBackfill', () => {
  it('assigns the policy default and requires user review when a scheduled chat has no backup', () => {
    expect(planScheduleBackupBackfill({
      schedule: { type: 'scheduled_chat' }, policy, supportedModelIds: ['gemini-3.1-flash-lite'],
    })).toEqual({
      action: 'update',
      llmBackupModel: 'gemini-3.1-flash-lite',
      llmBackupSource: 'system',
      llmBackupNeedsConfirmation: true,
      usagePolicyVersion: 'pro-v1',
    });
  });

  it('never overwrites a backup the user already selected', () => {
    expect(planScheduleBackupBackfill({
      schedule: { type: 'scheduled_chat', llmBackupModel: 'anthropic.claude-haiku-4-5-20251001-v1:0' },
      policy, supportedModelIds: ['gemini-3.1-flash-lite'],
    })).toEqual({ action: 'skip', reason: 'backup_already_present' });
  });

  it('fails closed if an admin policy points to an unsupported optimized default', () => {
    expect(() => planScheduleBackupBackfill({
      schedule: { type: 'scheduled_chat' }, policy, supportedModelIds: ['anthropic.claude-opus-5'],
    })).toThrow('has no supported optimized default');
  });
});
