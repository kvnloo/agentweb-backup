/**
 * Onboarding v2 analytics — Lead dual-write service.
 *
 * Every onboarding event the backend records on a User record is also mirrored
 * onto the matching Lead row in the founders@ "AgentWeb Signups" list. This
 * lets Fangfang review qualitative onboarding behavior on the Lead detail page
 * (her existing workflow) and lets Emma reason over Lead records programmatically
 * without needing to cross-join to User.
 *
 * Design invariants:
 *   - Fire-and-forget. Errors NEVER propagate — onboarding event recording
 *     must succeed even if the Lead mirror fails.
 *   - Idempotent. The full event log is overwritten on every call, so rerunning
 *     the mirror with the same state produces the same Lead row.
 *   - If the Lead doesn't exist, create it. The `signupAutoEnrollService` creates
 *     a Lead on signup, but some users (older accounts, edge-case signups)
 *     may not have one — we create on first onboarding event.
 *
 * Task: https://www.notion.so/34c09247c951812cbc90f09aa68fc5d3
 */

import type { OnboardingEvent, OnboardingStage } from '../utils/onboardingStage';
import { crmDb as defaultCrmDb } from './db';
import { FOUNDERS_USERID, FOUNDERS_SIGNUPS_LIST_NAME } from './signupAutoEnrollService';

/**
 * The top-level Lead attributes used by the onboarding mirror. Kept as exported
 * constants so the admin Lead detail page and tests reference one source of
 * truth instead of magic strings.
 */
export const ONBOARDING_LEAD_FIELD = 'onboardingEvents';
export const ONBOARDING_STAGE_FIELD = 'onboardingStage';
export const ONBOARDING_DEVIATION_COUNT_FIELD = 'onboardingDeviationCount';

export interface MirrorOnboardingInput {
  /** AgentWeb User.userId that owns the onboarding event. */
  userId: string;
  /** Email of the user — used to match the Lead row. */
  email: string;
  /** The single event being mirrored (included in allEvents too — present here for logging). */
  event: OnboardingEvent;
  /**
   * Full event log on the User record AFTER the new event was appended. The
   * full log is written to the Lead so the Lead record is a complete mirror.
   */
  allEvents: OnboardingEvent[];
  /** Derived onboarding stage on the User record, omitted for lateral events. */
  onboardingStage: OnboardingStage | null;
}

export interface MirrorOnboardingDeps {
  crmDb?: {
    getLeadListsByUserId: typeof defaultCrmDb.getLeadListsByUserId;
    getLeadByEmail: typeof defaultCrmDb.getLeadByEmail;
    createLead: typeof defaultCrmDb.createLead;
    updateLeadOnboardingAnalytics: typeof defaultCrmDb.updateLeadOnboardingAnalytics;
  };
  logger?: Pick<typeof console, 'error' | 'warn' | 'log'>;
}

export interface MirrorOnboardingOutcome {
  mirrored: boolean;
  reason:
    | 'no_email'
    | 'no_list'
    | 'created_and_updated'
    | 'updated'
    | 'error';
  listId?: string;
  leadId?: string;
}

/**
 * Count deviation events in the log. A deviation is any freeform user message
 * during onboarding that wasn't a button/form submit — frontend tags them as
 * event name `deviation`.
 */
function countDeviations(events: OnboardingEvent[]): number {
  return events.filter((e) => e?.event === 'deviation').length;
}

/**
 * Resolve the founders@ "AgentWeb Signups" list by name. Returns null if the
 * list hasn't been provisioned yet — in that case we don't attempt to mirror
 * (signupAutoEnrollService creates it lazily on the first signup, so cold-start
 * races are possible but self-healing on the next event).
 */
async function findFoundersSignupsList(
  crmDb: NonNullable<MirrorOnboardingDeps['crmDb']>,
): Promise<{ listId: string } | null> {
  const lists = await crmDb.getLeadListsByUserId(FOUNDERS_USERID);
  const match = (lists || []).find(
    (l: any) => l && typeof l.name === 'string' && l.name === FOUNDERS_SIGNUPS_LIST_NAME,
  );
  if (match && (match as any).listId) {
    return { listId: (match as any).listId };
  }
  return null;
}

/**
 * Mirror the freshly recorded onboarding event onto the caller's Lead row.
 *
 * Must never throw. Returns an outcome struct so the onboarding route can
 * log telemetry but otherwise ignore the return value.
 */
export async function mirrorOnboardingEventToLead(
  input: MirrorOnboardingInput,
  deps: MirrorOnboardingDeps = {},
): Promise<MirrorOnboardingOutcome> {
  const crmDb = deps.crmDb || defaultCrmDb;
  const logger = deps.logger || console;

  try {
    const email = (input.email || '').trim().toLowerCase();
    if (!email) {
      return { mirrored: false, reason: 'no_email' };
    }

    const list = await findFoundersSignupsList(crmDb);
    if (!list) {
      logger.warn(
        `[onboardingLeadSync] founders signups list missing — skipping mirror for ${email}`,
      );
      return { mirrored: false, reason: 'no_list' };
    }

    const existing = await crmDb.getLeadByEmail(list.listId, email);

    const analytics = {
      [ONBOARDING_LEAD_FIELD]: input.allEvents,
      [ONBOARDING_DEVIATION_COUNT_FIELD]: countDeviations(input.allEvents),
      ...(input.onboardingStage !== null && {
        [ONBOARDING_STAGE_FIELD]: input.onboardingStage,
      }),
    };

    if (existing && (existing as any).leadId) {
      await crmDb.updateLeadOnboardingAnalytics(list.listId, (existing as any).leadId, analytics);
      return {
        mirrored: true,
        reason: 'updated',
        listId: list.listId,
        leadId: (existing as any).leadId,
      };
    }

    // No Lead yet — create one. Signup auto-enroll should have done this
    // already; creating on the fly handles pre-existing users and races.
    const createdLead: any = await crmDb.createLead(list.listId, {
      email,
      lifecycle: 'signed_up',
      tenantId: FOUNDERS_USERID,
      accountOwnerUserId: FOUNDERS_USERID,
    });
    if (createdLead && createdLead.leadId) {
      await crmDb.updateLeadOnboardingAnalytics(list.listId, createdLead.leadId, analytics);
      return {
        mirrored: true,
        reason: 'created_and_updated',
        listId: list.listId,
        leadId: createdLead.leadId,
      };
    }

    return { mirrored: false, reason: 'error', listId: list.listId };
  } catch (err: any) {
    logger.error(
      '[onboardingLeadSync] failed to mirror onboarding event to Lead:',
      err?.message || err,
    );
    return { mirrored: false, reason: 'error' };
  }
}
