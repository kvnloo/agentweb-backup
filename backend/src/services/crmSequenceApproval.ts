/**
 * CRM drip-sequence send safety + input mapping (ENG-442).
 *
 * Pure module — no network, no DynamoDB, no service imports. It backs the
 * `list_crm_sequences` / `manage_crm_sequence` agent tools and holds the one
 * rule that matters: a drip sequence must never start sending to real leads
 * from an unattended run.
 *
 * The drip worker only mails an enrollment when the sequence's status is
 * `active` (see dripSequenceWorker.processEnrollment). So "activate" IS "start
 * sending", and it is the single action this gate guards. Creating stays at
 * `draft` and pausing stops sends, so both are safe in any run mode.
 */

// ─── Run mode ───────────────────────────────────────────────────────────────

export type SequenceRunMode = 'interactive' | 'unattended';

/**
 * Chat session types where a human is actually present and reading the turn.
 * This is an allowlist on purpose: any new or unrecognised session type is
 * treated as unattended, so the gate drifts toward blocking rather than
 * sending. `scheduled` (cron), `emma-email`, `meeting-intake` and friends are
 * all automated and deliberately absent.
 */
export const ATTENDED_SESSION_TYPES: ReadonlyArray<string> = [
  'regular',
  'predefined-work-plan',
  'interactive_share',
];

const ATTENDED = new Set<string>(ATTENDED_SESSION_TYPES);

export interface SequenceRunContext {
  sessionId?: string;
  /** Explicit override from a caller that knows it is running unattended. */
  unattended?: boolean;
}

/**
 * Decide whether this tool call is happening in front of a human.
 *
 * Fails closed in every ambiguous case: no session, an unresolvable session id
 * (e.g. an external MCP transport id that is not a chat session), a lookup
 * error, or a session type not on the attended allowlist all resolve to
 * `unattended`.
 */
export async function resolveSequenceRunMode(
  context: SequenceRunContext | undefined | null,
  loadSessionType: (sessionId: string) => Promise<string | undefined | null>,
): Promise<SequenceRunMode> {
  if (context?.unattended === true) return 'unattended';

  const sessionId = context?.sessionId;
  if (!sessionId) return 'unattended';

  try {
    const sessionType = await loadSessionType(sessionId);
    if (typeof sessionType !== 'string') return 'unattended';
    return ATTENDED.has(sessionType) ? 'interactive' : 'unattended';
  } catch {
    return 'unattended';
  }
}

// ─── Approval decision ──────────────────────────────────────────────────────

export type SequenceApprovalDecision =
  | { approved: true }
  | { approved: false; reason: 'unattended_run'; message: string }
  | { approved: false; reason: 'confirmation_required'; message: string };

export const UNATTENDED_BLOCK_MESSAGE =
  'Blocked: a drip sequence cannot be activated from a scheduled or otherwise unattended run. ' +
  'Activating it would start sending real email to real leads with no human approval. ' +
  'Leave the sequence in draft/paused and report that it is ready for a person to activate — ' +
  'from an interactive chat with manage_crm_sequence(action="resume", confirm=true), or from the CRM UI.';

export const CONFIRMATION_REQUIRED_MESSAGE =
  'Not activated. Activating this sequence starts sending real email to real leads. ' +
  'Show the user the sequence preview below and get an explicit yes, then call again with confirm=true.';

/**
 * The gate. An unattended run is blocked unconditionally — `confirmed` cannot
 * override it, because in an unattended run the only thing that could have set
 * `confirm` is the model itself.
 */
export function evaluateSequenceSendApproval(input: {
  runMode: SequenceRunMode;
  confirmed: boolean;
}): SequenceApprovalDecision {
  if (input.runMode === 'unattended') {
    return { approved: false, reason: 'unattended_run', message: UNATTENDED_BLOCK_MESSAGE };
  }
  if (!input.confirmed) {
    return { approved: false, reason: 'confirmation_required', message: CONFIRMATION_REQUIRED_MESSAGE };
  }
  return { approved: true };
}

// ─── Input mapping ──────────────────────────────────────────────────────────

/** Bad tool input — surfaced to the model as a validation error, never sent to the API. */
export class SequenceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SequenceInputError';
  }
}

/** Mirrors LeadLifecycle in services/dripSequenceDb.ts. */
export const SEQUENCE_LIFECYCLES: ReadonlyArray<string> = [
  'unknown',
  'inbox',
  'signed_up',
  'in_deal',
  'trialing',
  'paying',
  'at_risk',
  'churned',
];

/** Mirrors SequenceCampaignType in services/dripSequenceDb.ts. */
export const SEQUENCE_CAMPAIGN_TYPES: ReadonlyArray<string> = [
  'conversion',
  'onboarding',
  'reengagement',
  'nurture',
  'upsell',
  'custom',
];

export interface SequenceTargetInput {
  lead_list_id?: string;
  lifecycle?: string;
  min_heat_score?: number;
}

export interface SequenceTargeting {
  enrollmentTrigger: { type: string; listId?: string; lifecycleStage?: string };
  enrollmentCondition?: { field: string; operator: string; value: unknown };
}

/**
 * Map the tool's segment vocabulary onto the drip engine's enrollment model.
 *
 * The engine has exactly one trigger and one `enrollmentCondition` slot, so a
 * target needing two conditions is rejected loudly rather than silently
 * dropping half the segment.
 */
export function buildSequenceTargeting(
  target: SequenceTargetInput | undefined | null,
): SequenceTargeting {
  const listId = typeof target?.lead_list_id === 'string' ? target.lead_list_id.trim() : '';
  const lifecycle = typeof target?.lifecycle === 'string' ? target.lifecycle.trim() : '';
  const rawHeat = target?.min_heat_score;
  const hasHeat = rawHeat !== undefined && rawHeat !== null;

  if (lifecycle && !SEQUENCE_LIFECYCLES.includes(lifecycle)) {
    throw new SequenceInputError(
      `target.lifecycle must be one of: ${SEQUENCE_LIFECYCLES.join(', ')} (got "${lifecycle}").`,
    );
  }

  let minHeatScore: number | undefined;
  if (hasHeat) {
    if (typeof rawHeat !== 'number' || !Number.isFinite(rawHeat) || rawHeat < 0 || rawHeat > 100) {
      throw new SequenceInputError('target.min_heat_score must be a number between 0 and 100.');
    }
    minHeatScore = rawHeat;
  }

  if (listId && lifecycle && minHeatScore !== undefined) {
    throw new SequenceInputError(
      'A sequence supports one enrollment condition. Targeting a list plus BOTH lifecycle and ' +
        'min_heat_score needs two. Pick one, or drop lead_list_id so lifecycle drives the trigger.',
    );
  }

  if (listId) {
    const targeting: SequenceTargeting = {
      enrollmentTrigger: { type: 'list_membership', listId },
    };
    if (lifecycle) {
      targeting.enrollmentCondition = { field: 'lifecycle', operator: 'eq', value: lifecycle };
    } else if (minHeatScore !== undefined) {
      targeting.enrollmentCondition = { field: 'heatScore', operator: 'gte', value: minHeatScore };
    }
    return targeting;
  }

  if (lifecycle) {
    const targeting: SequenceTargeting = {
      enrollmentTrigger: { type: 'lifecycle_change', lifecycleStage: lifecycle },
    };
    if (minHeatScore !== undefined) {
      targeting.enrollmentCondition = { field: 'heatScore', operator: 'gte', value: minHeatScore };
    }
    return targeting;
  }

  if (minHeatScore !== undefined) {
    return {
      enrollmentTrigger: { type: 'manual' },
      enrollmentCondition: { field: 'heatScore', operator: 'gte', value: minHeatScore },
    };
  }

  return { enrollmentTrigger: { type: 'manual' } };
}

export interface SequenceStepInput {
  name?: string;
  subject?: string;
  body_html?: string;
  delay_days?: number;
}

export interface NormalizedSequenceStep {
  stepNumber: number;
  name: string;
  delayDays: number;
  channel: 'email';
  subject: string;
  bodyHtml: string;
}

/** Default gap between steps when the caller does not specify a cadence. */
const DEFAULT_FOLLOW_UP_DELAY_DAYS = 3;

export function normalizeSequenceSteps(
  steps: SequenceStepInput[] | undefined | null,
): NormalizedSequenceStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new SequenceInputError('steps is required and must contain at least one email step.');
  }

  return steps.map((step, index) => {
    const subject = typeof step?.subject === 'string' ? step.subject.trim() : '';
    const bodyHtml = typeof step?.body_html === 'string' ? step.body_html.trim() : '';

    if (!subject || !bodyHtml) {
      throw new SequenceInputError(
        `steps[${index}] needs both subject and body_html — an email step with no copy cannot be sent.`,
      );
    }

    let delayDays = index === 0 ? 0 : DEFAULT_FOLLOW_UP_DELAY_DAYS;
    if (step?.delay_days !== undefined && step.delay_days !== null) {
      if (!Number.isInteger(step.delay_days) || step.delay_days < 0) {
        throw new SequenceInputError(
          `steps[${index}].delay_days must be a non-negative whole number of days.`,
        );
      }
      delayDays = step.delay_days;
    }

    return {
      stepNumber: index + 1,
      name: typeof step?.name === 'string' && step.name.trim() ? step.name.trim() : `Step ${index + 1}`,
      delayDays,
      channel: 'email' as const,
      subject,
      bodyHtml,
    };
  });
}

// ─── Summaries ──────────────────────────────────────────────────────────────

/** Human-readable description of who a sequence targets. */
export function describeSequenceTarget(sequence: any): string {
  const parts: string[] = [];
  const trigger = sequence?.enrollmentTrigger;

  if (trigger?.type === 'list_membership' && trigger.listId) {
    parts.push(`leads in list ${trigger.listId}`);
  } else if (trigger?.type === 'lifecycle_change' && trigger.lifecycleStage) {
    parts.push(`leads entering lifecycle "${trigger.lifecycleStage}"`);
  } else if (trigger?.type === 'linkedin_connection_accepted') {
    parts.push('leads whose LinkedIn connection was accepted');
  } else {
    parts.push('manual enrollment only');
  }

  const condition = sequence?.enrollmentCondition;
  if (condition?.field && condition.operator) {
    const value = condition.value === undefined ? '' : ` ${String(condition.value)}`;
    parts.push(`where ${condition.field} ${condition.operator}${value}`);
  }

  const autoLists: unknown = sequence?.autoEnrollListIds;
  if (Array.isArray(autoLists) && autoLists.length > 0) {
    parts.push(`auto-enrolling new leads from: ${autoLists.join(', ')}`);
  }

  return parts.join(', ');
}

export interface SequenceSummary {
  sequence_id: string;
  name: string;
  status: string;
  campaign_type?: string;
  step_count: number;
  target: string;
  /** True only when the drip worker will actually mail this sequence's enrollments. */
  is_sending: boolean;
  created_at?: string;
  updated_at?: string;
}

export function summarizeSequence(sequence: any): SequenceSummary {
  return {
    sequence_id: sequence?.sequenceId,
    name: sequence?.name,
    status: sequence?.status,
    campaign_type: sequence?.campaignType,
    step_count: Array.isArray(sequence?.steps) ? sequence.steps.length : 0,
    target: describeSequenceTarget(sequence),
    is_sending: sequence?.status === 'active',
    created_at: sequence?.createdAt,
    updated_at: sequence?.updatedAt,
  };
}
