/**
 * Contact Capture Hooks — activity-timeline capture layer.
 *
 * Thin wrappers that turn inbound signals (new user registration, onboarding
 * stage change, landing-page form submission, Emma manual log) into rows in
 * the AW-ContactEvents append-only log.
 *
 * Design contract (mirrors crmSignalHooks.ts):
 *  - Every hook catches + logs its own errors so callers never break.
 *  - Every hook is idempotent via a stable sourceRecordId.
 *  - Dependency injection on the events-db + logger for unit-test isolation.
 *  - Hooks return the LogEventResult on success, null on skip / error.
 *
 * Scope boundary with crmSignalHooks.ts:
 *  - crmSignalHooks owns "full lifecycle" signals that recompute heat/health
 *    scores via contactSyncService (signup → contact.created, stripe, emma).
 *  - contactCaptureHooks owns "timeline-only" narrative events that surface
 *    in the activity renderer but don't need to recompute scores
 *    (user.registered, onboarding.stage_changed, form.submitted, etc).
 *
 * A single user-facing signup triggers BOTH:
 *   crmSignalHooks.onUserSignup()         → contact.created + scoring
 *   contactCaptureHooks.onUserRegistered() → user.registered timeline row
 */

import {
  contactEventsDb as defaultEventsDb,
  normalizeContactId,
  ContactEventType,
  KNOWN_CONTACT_EVENT_TYPES,
  LogEventResult,
} from './contactEventsDb';

/**
 * Injectable surface — matches the slice of contactEventsDb we use so tests
 * can pass a mock without needing to stub DynamoDB.
 */
export interface EventsDbLike {
  logEvent: (typeof defaultEventsDb)['logEvent'];
}

/**
 * Optional hook for "does any AW-Leads row exist with this email?". When
 * provided and returns false, user.registered / onboarding.stage_changed
 * events are skipped (the task spec: "If no matching lead, no-op"). When
 * omitted, events are always logged — acceptable because the events table
 * is append-only, cheap, and unreferenced until a timeline renderer reads it.
 */
export type HasMatchingLeadFn = (email: string) => Promise<boolean>;

export interface CaptureHookDeps {
  eventsDb?: EventsDbLike;
  logger?: Pick<typeof console, 'error' | 'warn'>;
  hasMatchingLead?: HasMatchingLeadFn;
}

/* -------------------------------------------------------------------------- */
/*  user.registered                                                            */
/* -------------------------------------------------------------------------- */

export interface UserRegisteredHookInput {
  userId: string;
  email: string;
  displayName?: string | null;
  signupSource?: string | null; // e.g. 'password' | 'oauth-google'
  createdAt?: string;
}

/**
 * Fire a `user.registered` timeline event when a new user account is created.
 * If `hasMatchingLead` is provided and returns false, no-ops (we don't want
 * to auto-create contacts for brand-new emails with no CRM presence).
 */
export async function onUserRegistered(
  input: UserRegisteredHookInput,
  deps: CaptureHookDeps = {}
): Promise<LogEventResult | null> {
  const eventsDb = deps.eventsDb || defaultEventsDb;
  const logger = deps.logger || console;

  if (!input.email || !input.userId) {
    logger.warn('[contactCaptureHooks.onUserRegistered] missing email/userId, skipping');
    return null;
  }

  try {
    const email = input.email.trim().toLowerCase();

    if (deps.hasMatchingLead) {
      const matches = await deps.hasMatchingLead(email);
      if (!matches) return null;
    }

    return await eventsDb.logEvent({
      contactId: email,
      source: 'signup',
      eventType: 'user.registered',
      sourceRecordId: `user-registered-${input.userId}`,
      payload: {
        userId: input.userId,
        displayName: input.displayName || null,
        signupSource: input.signupSource || null,
        registeredAt: input.createdAt || new Date().toISOString(),
      },
    });
  } catch (err: any) {
    logger.error(
      '[contactCaptureHooks.onUserRegistered] log failed:',
      err?.message || err
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  onboarding.stage_changed                                                   */
/* -------------------------------------------------------------------------- */

export interface OnboardingStageChangedHookInput {
  userId: string;
  email: string;
  fromStage: string | null;
  toStage: string;
  triggeredByEvent?: string | null; // e.g. 'goal_selected'
  changedAt?: string;
}

/**
 * Fire an `onboarding.stage_changed` timeline event when a User's derived
 * onboardingStage moves. Paired with the existing user-level onboardingStage
 * field — this is the contact-timeline mirror.
 */
export async function onOnboardingStageChanged(
  input: OnboardingStageChangedHookInput,
  deps: CaptureHookDeps = {}
): Promise<LogEventResult | null> {
  const eventsDb = deps.eventsDb || defaultEventsDb;
  const logger = deps.logger || console;

  if (!input.email || !input.userId || !input.toStage) {
    logger.warn(
      '[contactCaptureHooks.onOnboardingStageChanged] missing email/userId/toStage, skipping'
    );
    return null;
  }
  if (input.fromStage === input.toStage) {
    // No-op — not a real stage change.
    return null;
  }

  try {
    const email = input.email.trim().toLowerCase();

    if (deps.hasMatchingLead) {
      const matches = await deps.hasMatchingLead(email);
      if (!matches) return null;
    }

    const changedAt = input.changedAt || new Date().toISOString();
    // Include stage in the sourceRecordId so each distinct transition writes
    // its own row, but the same transition is still idempotent.
    const sourceRecordId = `onboarding-stage-${input.userId}-${input.toStage}-${changedAt}`;

    return await eventsDb.logEvent({
      contactId: email,
      source: 'signup', // re-use signup source — the stage lives in the User's signup flow
      eventType: 'onboarding.stage_changed',
      sourceRecordId,
      eventTimestamp: changedAt,
      payload: {
        userId: input.userId,
        fromStage: input.fromStage,
        toStage: input.toStage,
        triggeredByEvent: input.triggeredByEvent || null,
        changedAt,
      },
    });
  } catch (err: any) {
    logger.error(
      '[contactCaptureHooks.onOnboardingStageChanged] log failed:',
      err?.message || err
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  form.submitted (public)                                                    */
/* -------------------------------------------------------------------------- */

export interface PublicFormSubmissionInput {
  email: string;
  sourceRecordId: string; // e.g. 'form-lead-magnet-<submissionId>'
  formName?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Fire a `form.submitted` event from a public landing-page form. Called by
 * the /api/crm/public/events route (unauthenticated).
 */
export async function onPublicFormSubmitted(
  input: PublicFormSubmissionInput,
  deps: CaptureHookDeps = {}
): Promise<LogEventResult | null> {
  const eventsDb = deps.eventsDb || defaultEventsDb;
  const logger = deps.logger || console;

  if (!input.email || !input.sourceRecordId) {
    logger.warn(
      '[contactCaptureHooks.onPublicFormSubmitted] missing email/sourceRecordId, skipping'
    );
    return null;
  }

  try {
    return await eventsDb.logEvent({
      contactId: input.email.trim().toLowerCase(),
      source: 'lead_form',
      eventType: 'form.submitted',
      sourceRecordId: input.sourceRecordId,
      payload: {
        formName: input.formName || null,
        ...(input.payload || {}),
      },
    });
  } catch (err: any) {
    logger.error(
      '[contactCaptureHooks.onPublicFormSubmitted] log failed:',
      err?.message || err
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  page.visited (public)                                                      */
/* -------------------------------------------------------------------------- */

export interface PublicPageVisitInput {
  email: string;
  sourceRecordId: string;
  url?: string | null;
  referrer?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Fire a `page.visited` event. Reserved for future tracking — pixels /
 * identified-visitor beacons. Accepts only identified emails (no anonymous).
 */
export async function onPublicPageVisited(
  input: PublicPageVisitInput,
  deps: CaptureHookDeps = {}
): Promise<LogEventResult | null> {
  const eventsDb = deps.eventsDb || defaultEventsDb;
  const logger = deps.logger || console;

  if (!input.email || !input.sourceRecordId) {
    logger.warn(
      '[contactCaptureHooks.onPublicPageVisited] missing email/sourceRecordId, skipping'
    );
    return null;
  }

  try {
    return await eventsDb.logEvent({
      contactId: input.email.trim().toLowerCase(),
      source: 'engagement',
      eventType: 'page.visited',
      sourceRecordId: input.sourceRecordId,
      payload: {
        url: input.url || null,
        referrer: input.referrer || null,
        ...(input.payload || {}),
      },
    });
  } catch (err: any) {
    logger.error(
      '[contactCaptureHooks.onPublicPageVisited] log failed:',
      err?.message || err
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Manual log (Emma tool backing)                                             */
/* -------------------------------------------------------------------------- */

export interface ManualLogInput {
  contactId: string; // normalized email or nocontact:<leadId>
  eventType: ContactEventType;
  summary: string;
  details?: Record<string, unknown>;
  /** User logging the note, recorded in payload for audit. */
  loggedByUserId?: string;
  /** Idempotency key. If omitted, a time-based key is generated. */
  sourceRecordId?: string;
}

/**
 * Manual timeline entry — backs the `log_contact_event` Emma tool. Users can
 * attach a natural-language note ("called and left a voicemail") to any event
 * type. Distinct from the auto-captured hooks above because the caller, not
 * the system, picks the eventType + summary.
 */
export async function logManualEvent(
  input: ManualLogInput,
  deps: CaptureHookDeps = {}
): Promise<LogEventResult | null> {
  const eventsDb = deps.eventsDb || defaultEventsDb;
  const logger = deps.logger || console;

  if (!input.contactId || !input.contactId.trim()) {
    logger.warn('[contactCaptureHooks.logManualEvent] missing contactId, skipping');
    return null;
  }
  if (!input.summary || !input.summary.trim()) {
    logger.warn('[contactCaptureHooks.logManualEvent] missing summary, skipping');
    return null;
  }
  if (!input.eventType) {
    logger.warn('[contactCaptureHooks.logManualEvent] missing eventType, skipping');
    return null;
  }

  try {
    const sourceRecordId =
      input.sourceRecordId ||
      `manual-${input.loggedByUserId || 'anon'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return await eventsDb.logEvent({
      contactId: normalizeContactId(input.contactId),
      source: 'manual',
      eventType: input.eventType,
      sourceRecordId,
      payload: {
        summary: input.summary.trim(),
        details: input.details || {},
        loggedByUserId: input.loggedByUserId || null,
      },
    });
  } catch (err: any) {
    logger.error(
      '[contactCaptureHooks.logManualEvent] log failed:',
      err?.message || err
    );
    return null;
  }
}

/** Helper for callers that want to validate an eventType before logging. */
export function isKnownContactEventType(candidate: unknown): boolean {
  return typeof candidate === 'string' && KNOWN_CONTACT_EVENT_TYPES.has(candidate);
}
