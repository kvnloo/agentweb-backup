/**
 * ENG-1723 / ENG-1609 AC #10 — create the outreach schedule at onboarding
 * instead of making the customer know to ask Emma for it in chat.
 *
 * THE UNDEFINED TERM. AC #10 originally read "for any customer whose plan
 * promises a daily outreach volume". That phrase has no referent in code:
 * `SubscriptionType` carries allowedPages, allowedSkills,
 * allowedConnectedAccounts, allowedFeatures and token/cost allowances — there is
 * no outreach-volume concept anywhere, and tier definitions live in an
 * admin-managed DynamoDB setting. Rather than add a billing field to serve one
 * trigger, the criterion was redefined (parent's Amendments table, 2026-09-03) as
 * three predicates that ARE checkable:
 *
 *   (a) a LinkedIn Outreach (unipile) account is connected,
 *   (b) an ICP is known — in practice the lead list the onboarding flow just
 *       minted from it, which is also the `lead_list_id` the template needs,
 *   (c) the tier is outreach-capable: the `scheduled_chats` feature is enabled
 *       AND `unipile` is an allowed connected-account platform.
 *
 * WHY THE FLAG IS NOT OPTIONAL. This creates a LIVE schedule that sends real
 * connection requests from a real person's LinkedIn account with no chat
 * interaction. A wrong predicate means unrequested outreach under someone's own
 * name — irreversible and reputational. ENG-1721's warm-up ramp and the daily cap
 * bound the blast radius, but bounded is not acceptable. So: default-off flag,
 * plus a dry-run that works regardless of the flag, following ENG-1557 v1's
 * `MANAGE_LEADS_CROSS_ACCOUNT_ADD_ENABLED` precedent — prove the mechanism before
 * anything is ever actually written.
 *
 * FAIL CLOSED, ALWAYS. `isSubscriptionFeatureEnabled` returns `boolean | null`,
 * where null means the admin setting could not be resolved. Background jobs
 * elsewhere are allowed to treat null as "retry later"; this one must not create
 * outreach on an unresolved entitlement, so null is a refusal with its own
 * distinct reason.
 *
 * NEVER SILENT. Every path returns a named reason (AC #5). "Nothing happened" and
 * "nothing happened because the tier could not be resolved" are different facts,
 * and the second is the one worth acting on.
 */

/** Default OFF. Set to the string 'true' to allow real writes. */
export const OUTREACH_AUTO_CREATE_FLAG = 'OUTREACH_SCHEDULE_AUTO_CREATE_ENABLED';

export const isOutreachAutoCreateEnabled = (): boolean =>
  process.env[OUTREACH_AUTO_CREATE_FLAG] === 'true';

/**
 * The default this schedule is created with. 10, matching
 * `DEFAULT_DAILY_INVITE_CAP` and the parent's amended AC #5 — a higher number
 * would exceed the real per-account cap for the 14 of 16 production accounts that
 * have configured none. The backend clamps it regardless; this is the stated
 * intent, not an enforcement point.
 */
export const DEFAULT_DAILY_CONNECTION_TARGET = '10';

export type AutoCreateOutcome =
  | 'created'
  | 'dry_run'
  | 'skipped';

export type AutoCreateReason =
  | 'eligible'
  /** The flag is off. Not a defect — this is the shipped default. */
  | 'flag_disabled'
  /** No connected unipile account: predicate (a). */
  | 'no_linkedin_account'
  /** No ICP-derived lead list to target: predicate (b). */
  | 'no_icp'
  /** Tier resolved and does not permit outreach: predicate (c). */
  | 'tier_not_outreach_capable'
  /** Tier could NOT be resolved — refused rather than assumed either way. */
  | 'tier_unresolved'
  /** No system template to create from — C6/ENG-1722 has not been seeded here. */
  | 'template_missing'
  /** This customer already has one. Re-running onboarding must not make a second. */
  | 'already_exists';

export interface AutoCreateDecision {
  create: boolean;
  reason: AutoCreateReason;
  /** One line, safe to log or surface. Always populated. */
  detail: string;
}

export interface AutoCreateTriggerInput {
  flagEnabled: boolean;
  /** A dry run evaluates every predicate but never writes — see the docblock. */
  dryRun: boolean;
  hasLinkedInAccount: boolean;
  leadListId?: string | null;
  /** null when the entitlement could not be resolved at all. */
  tierOutreachCapable: boolean | null;
  templateId?: string | null;
  /** An already-auto-created schedule for this customer, if any. */
  existingScheduleId?: string | null;
}

/**
 * Decide whether to create. Pure — no I/O, no environment reads.
 *
 * Predicate order is deliberate: the checks that describe the CUSTOMER'S state
 * come before the ones that describe OURS, so the reason a customer did not get a
 * schedule is the most actionable one available. `already_exists` is checked
 * first of all — it is the only reason that means "this is working correctly and
 * there is nothing to do", and reporting a missing predicate for a customer who
 * already has a schedule would be misleading.
 */
export function evaluateAutoCreateTrigger(input: AutoCreateTriggerInput): AutoCreateDecision {
  if (input.existingScheduleId) {
    return {
      create: false,
      reason: 'already_exists',
      detail: `Outreach schedule ${input.existingScheduleId} already exists for this customer; not creating a second.`,
    };
  }
  if (!input.hasLinkedInAccount) {
    return {
      create: false,
      reason: 'no_linkedin_account',
      detail: 'No connected LinkedIn Outreach account — a schedule that cannot send would fail on its first run.',
    };
  }
  if (!input.leadListId) {
    return {
      create: false,
      reason: 'no_icp',
      detail: 'No ICP-derived lead list to target, so there is nothing for the schedule to work from.',
    };
  }
  if (input.tierOutreachCapable === null) {
    return {
      create: false,
      reason: 'tier_unresolved',
      detail:
        'Subscription entitlement could not be resolved. Refusing rather than assuming: this creates live '
        + 'outreach from the customer\'s own LinkedIn account.',
    };
  }
  if (input.tierOutreachCapable === false) {
    return {
      create: false,
      reason: 'tier_not_outreach_capable',
      detail: 'Subscription tier does not permit scheduled chats and/or a connected LinkedIn account.',
    };
  }
  if (!input.templateId) {
    return {
      create: false,
      reason: 'template_missing',
      detail:
        'The "Daily LinkedIn Connection + Outreach Agent" system template is not present in this environment '
        + '(seed it with scripts/seed-eng1609-linkedin-outreach-template.ts).',
    };
  }
  // Every predicate holds. The flag decides only whether a REAL write happens —
  // a dry run has proven the whole trigger by this point, which is the thing
  // worth proving before the flag is ever flipped.
  if (!input.flagEnabled && !input.dryRun) {
    return {
      create: false,
      reason: 'flag_disabled',
      detail: `Every precondition is met; ${OUTREACH_AUTO_CREATE_FLAG} is not 'true', so nothing was created.`,
    };
  }
  return { create: true, reason: 'eligible', detail: 'All preconditions met.' };
}

export interface AutoCreatePlan {
  userId: string;
  templateId: string;
  templateName: string;
  leadListId: string;
  icpDescription: string;
  dailyConnectionTarget: string;
  frequency: string;
}

export interface AutoCreateResult {
  outcome: AutoCreateOutcome;
  reason: AutoCreateReason;
  detail: string;
  /** Present whenever every predicate held — i.e. on 'created' AND on 'dry_run'. */
  plan?: AutoCreatePlan;
  /** Present only on 'created'. */
  scheduleId?: string;
}

export interface AutoCreateDeps {
  /** The customer's OWN connected unipile account ids. Org-shared is deliberately
   *  not enough: this schedule sends under whoever owns the account. */
  listOwnUnipileAccountIds: (userId: string) => Promise<string[]>;
  /** `isSubscriptionFeatureEnabled(userId, 'scheduled_chats')` — null when unresolved. */
  scheduledChatsEnabled: (userId: string) => Promise<boolean | null>;
  /** `getAllowedConnectedAccounts(userId)`. */
  allowedConnectedAccounts: (userId: string) => Promise<string[]>;
  /** The seeded system template, or null. */
  findTemplate: () => Promise<{ templateId: string; name: string; startingMessage: string; variables: any[]; requiredFunctionCalls?: string[]; functionCallMinCalls?: Record<string, number>; suggestedFrequency?: string; description?: string } | null>;
  /** An existing auto-created schedule for this customer, or null. */
  findExistingSchedule: (userId: string, templateId: string) => Promise<string | null>;
  /** Persist. Only ever called on a real, flag-enabled create. */
  createSchedule: (schedule: Record<string, any>) => Promise<unknown>;
  countTemplateUse?: (templateId: string) => Promise<unknown>;
  now?: () => Date;
  newId?: () => string;
}

/** Is this tier outreach-capable? `null` propagates — never collapsed to false. */
export async function resolveTierOutreachCapable(
  userId: string,
  deps: Pick<AutoCreateDeps, 'scheduledChatsEnabled' | 'allowedConnectedAccounts'>,
): Promise<boolean | null> {
  const scheduled = await deps.scheduledChatsEnabled(userId);
  if (scheduled === null) return null;
  if (scheduled === false) return false;
  const allowed = await deps.allowedConnectedAccounts(userId);
  if (!Array.isArray(allowed)) return null;
  return allowed.includes('*') || allowed.includes('unipile');
}

/**
 * Evaluate the trigger and, when it holds and the flag is on, create the
 * schedule. A dry run performs every read and every check and stops short of the
 * one write.
 */
export async function autoCreateOutreachSchedule(params: {
  userId: string;
  leadListId?: string | null;
  /** The ICP label onboarding captured; becomes the schedule's targeting text. */
  icpDescription?: string | null;
  dryRun?: boolean;
  deps: AutoCreateDeps;
}): Promise<AutoCreateResult> {
  const { userId, deps } = params;
  const dryRun = params.dryRun === true;

  const [accountIds, tierOutreachCapable, template] = await Promise.all([
    deps.listOwnUnipileAccountIds(userId).catch(() => [] as string[]),
    resolveTierOutreachCapable(userId, deps).catch(() => null),
    deps.findTemplate().catch(() => null),
  ]);

  const existingScheduleId = template
    ? await deps.findExistingSchedule(userId, template.templateId).catch(() => null)
    : null;

  const decision = evaluateAutoCreateTrigger({
    flagEnabled: isOutreachAutoCreateEnabled(),
    dryRun,
    hasLinkedInAccount: accountIds.length > 0,
    leadListId: params.leadListId,
    tierOutreachCapable,
    templateId: template?.templateId,
    existingScheduleId,
  });

  if (!decision.create) {
    return { outcome: 'skipped', reason: decision.reason, detail: decision.detail };
  }

  // Non-null by construction: evaluateAutoCreateTrigger returns create:false for
  // a missing template or lead list before reaching here.
  const plan: AutoCreatePlan = {
    userId,
    templateId: template!.templateId,
    templateName: template!.name,
    leadListId: String(params.leadListId),
    icpDescription: (params.icpDescription || '').trim() || 'the audience captured during onboarding',
    dailyConnectionTarget: DEFAULT_DAILY_CONNECTION_TARGET,
    frequency: template!.suggestedFrequency || 'daily',
  };

  if (dryRun) {
    return {
      outcome: 'dry_run',
      reason: 'eligible',
      detail:
        `Would create "${plan.templateName}" for ${plan.userId} against lead list ${plan.leadListId} `
        + `at ${plan.dailyConnectionTarget} connection requests per ${plan.frequency} run. Nothing was written.`,
      plan,
    };
  }

  const now = (deps.now ?? (() => new Date()))();
  const scheduleId = (deps.newId ?? (() => require('uuid').v4()))();
  const { calculateNextRunTime } = await import('../../controllers/agentModeController');

  // Every template variable gets a value. There are no optional variables — a
  // declared variable left blank hard-fails the run before the model is called —
  // which is exactly why the template documents literal defaults for the two the
  // parent ticket describes as optional.
  const variableValues: Record<string, string> = {
    icp_description: plan.icpDescription,
    daily_connection_target: plan.dailyConnectionTarget,
    message_template: 'default',
    lead_list_id: plan.leadListId,
  };

  const schedule = {
    scheduleId,
    taskId: 'global',
    userId,
    frequency: plan.frequency,
    scheduleName: template!.name,
    description: template!.description || '',
    startingMessage: template!.startingMessage,
    keywords: [],
    requiredFunctionCalls: template!.requiredFunctionCalls || [],
    functionCallMinCalls: template!.functionCallMinCalls || {},
    emailNotifications: [],
    dailyDigest: false,
    // AC #6: an ordinary active schedule. No hidden flag, no undeletable marker —
    // the customer can see, edit and pause it like any other.
    status: 'active',
    nextRunTime: calculateNextRunTime(plan.frequency, now, undefined, scheduleId).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sessionId: null,
    type: 'scheduled_chat',
    llmModel: '',
    runCount: -1,
    variables: template!.variables || [],
    variableValues,
    variableRequestStatus: 'provided',
    // AC #4: the idempotency key. Stamped rather than inferred from the name, so
    // a customer renaming their schedule cannot cause a duplicate to be created.
    autoCreatedFromTemplateId: template!.templateId,
  };

  await deps.createSchedule(schedule);
  if (deps.countTemplateUse) {
    await Promise.resolve(deps.countTemplateUse(template!.templateId)).catch((err) =>
      console.error('[outreachScheduleAutoCreate] failed to increment template usage:', err),
    );
  }

  return {
    outcome: 'created',
    reason: 'eligible',
    detail: `Created "${plan.templateName}" (${scheduleId}) for ${userId} against lead list ${plan.leadListId}.`,
    plan,
    scheduleId,
  };
}
