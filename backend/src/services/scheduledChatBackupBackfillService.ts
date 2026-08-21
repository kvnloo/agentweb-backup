import type { LlmUsagePolicy } from './llmUsagePolicyService';

export type ScheduleBackupBackfillPlan =
  | { action: 'skip'; reason: 'not_scheduled_chat' | 'backup_already_present' | 'policy_not_configured' }
  | {
      action: 'update';
      llmBackupModel: string;
      llmBackupSource: 'system';
      llmBackupNeedsConfirmation: true;
      usagePolicyVersion: string;
    };

export function planScheduleBackupBackfill(input: {
  schedule: Record<string, unknown>;
  policy: LlmUsagePolicy | null | undefined;
  supportedModelIds: readonly string[];
}): ScheduleBackupBackfillPlan {
  if (input.schedule.type !== 'scheduled_chat') return { action: 'skip', reason: 'not_scheduled_chat' };
  if (typeof input.schedule.llmBackupModel === 'string' && input.schedule.llmBackupModel.trim()) {
    return { action: 'skip', reason: 'backup_already_present' };
  }
  if (!input.policy) return { action: 'skip', reason: 'policy_not_configured' };
  if (
    !input.policy.optimizedModelIds.includes(input.policy.optimizedDefaultModel) ||
    !input.supportedModelIds.includes(input.policy.optimizedDefaultModel)
  ) {
    throw new Error(`Policy ${input.policy.version} has no supported optimized default`);
  }
  return {
    action: 'update',
    llmBackupModel: input.policy.optimizedDefaultModel,
    llmBackupSource: 'system',
    llmBackupNeedsConfirmation: true,
    usagePolicyVersion: input.policy.version,
  };
}
