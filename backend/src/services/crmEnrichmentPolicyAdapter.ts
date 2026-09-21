import {
  selectPolicyModel,
  type LlmUsageMode,
  type LlmUsagePolicy,
  type ModelBackupSource,
  type PolicyModelDecision,
} from './llmUsagePolicyService';

export type CrmEnrichmentPolicyInput = {
  requestedModel?: string | null;
  backupModel?: string | null;
  backupSource?: ModelBackupSource | null;
  systemDefaultModel: string;
  supportedModelIds: readonly string[];
  policy: LlmUsagePolicy | null | undefined;
  usageMode: LlmUsageMode;
};

/**
 * Keeps CRM model admission on the shared policy seam. Callers must use the
 * returned effectiveModel for the client and treat null as a hard-cap pause.
 */
export function resolveCrmEnrichmentModel(input: CrmEnrichmentPolicyInput): PolicyModelDecision {
  return selectPolicyModel(input);
}
