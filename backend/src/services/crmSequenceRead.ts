/**
 * ENG-962 — read-only CRM sequence summaries for `list_crm_sequences`.
 *
 * Pure module — no network, no DynamoDB, no service imports. It shapes the
 * existing `/api/crm/sequences` read payloads into the tool's contract:
 *
 * - `is_sending` is true ONLY for `active` sequences, because the drip worker
 *   mails nothing for draft/paused/archived sequences.
 * - `audience` reports the field the drip worker actually reads
 *   (`autoEnrollListIds`), never the aspirational `enrollmentTrigger`.
 *
 * There is deliberately no send surface here — no create/activate/pause.
 * Those live behind the send-safety gate in the sibling ENG-442 work
 * (manage_crm_sequence, ENG-963/964) and must never be added to this module.
 */

export interface SequenceSummaryInput {
  sequenceId?: string;
  name?: string;
  status?: string;
  campaignType?: string;
  steps?: unknown[];
  enrollmentTrigger?: { type?: string; listId?: string; lifecycleStage?: string };
  autoEnrollListIds?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface SequenceSummary {
  sequence_id?: string;
  name?: string;
  status?: string;
  campaign_type?: string;
  step_count: number;
  audience: string;
  is_sending: boolean;
  created_at?: string;
  updated_at?: string;
}

/**
 * Human-readable description of who a sequence actually enrolls.
 * Reads `autoEnrollListIds` first — that is the field the drip worker queries
 * (`getSequencesByAutoEnrollList`). The `enrollmentTrigger` is reported only
 * as secondary context, so an `active` sequence with no auto-enroll lists is
 * never described as reaching leads it cannot mail.
 */
export function describeSequenceAudience(sequence: SequenceSummaryInput): string {
  const parts: string[] = [];
  const autoLists = sequence?.autoEnrollListIds;
  if (Array.isArray(autoLists) && autoLists.length > 0) {
    parts.push(`auto-enrolling new leads from: ${autoLists.join(", ")}`);
  } else {
    parts.push("manual enrollment only — no auto-enroll lists, so no new leads are being added");
  }

  const trigger = sequence?.enrollmentTrigger;
  if (trigger?.type === "list_membership" && trigger.listId) {
    parts.push(`trigger: leads in list ${trigger.listId}`);
  } else if (trigger?.type === "lifecycle_change" && trigger.lifecycleStage) {
    parts.push(`trigger: leads entering lifecycle "${trigger.lifecycleStage}"`);
  }

  return parts.join(", ");
}

export function summarizeSequence(sequence: SequenceSummaryInput): SequenceSummary {
  return {
    sequence_id: sequence?.sequenceId,
    name: sequence?.name,
    status: sequence?.status,
    campaign_type: sequence?.campaignType,
    step_count: Array.isArray(sequence?.steps) ? sequence.steps.length : 0,
    audience: describeSequenceAudience(sequence),
    is_sending: sequence?.status === "active",
    created_at: sequence?.createdAt,
    updated_at: sequence?.updatedAt,
  };
}
