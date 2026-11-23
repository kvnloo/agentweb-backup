/**
 * ENG-2816: tool restriction profiles, the one place that says which tools a restricted principal may not run.
 *
 * A share-link visitor acts under the OWNER's userId, so the usual "does this user own it" checks pass for them. What they
 * must not do is therefore stated here, by profile, and enforced wherever a tool runs:
 *  - the text chat preflight (`agentMode/core/toolDispatch.ts`), which gives the model a clear refusal;
 *  - `agentModeService.executeTool`, which every path ends in (voice, text, nested), so a path that forgets the preflight
 *    still fails closed;
 *  - later, scheduled runs a visitor created.
 *
 * To restrict a new kind of principal (for example inbound email or Slack senders), add an entry to PROFILES and pass its id
 * as `restrictionProfile` in the tool context. Nothing else about tool execution needs to change.
 *
 * `share_visitor_schedule` (ENG-2816 step 3) is the same restriction for a scheduled run whose schedule a visitor set up or
 * edited through a share link: same block list, but its own refusal wording, because "shared sessions" would mislead the owner
 * reading a scheduled run's result. `executeTool` applies it live, from the schedule's provenance (`utils/scheduleProvenance`).
 *
 * This module imports nothing, so it can be used from anywhere without creating an import cycle.
 */

export type RestrictionProfileId = 'share_visitor' | 'share_visitor_schedule';

/** The profile a marked schedule's runs (and its own tool calls) carry. */
export const SHARE_VISITOR_SCHEDULE_PROFILE: RestrictionProfileId = 'share_visitor_schedule';

/**
 * Tools that act on the owner's own account, settings or memory. A share-link visitor runs under the owner's userId, so these
 * would reach the owner's data; memory written here is also injected into later owner and org sessions.
 */
export const SHARE_VISITOR_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'get_lead_notification_settings',
  'update_lead_notification_settings',
  'get_hot_lead_call_settings',
  'update_hot_lead_call_settings',
  'provision_hot_lead_call_number',
  'release_hot_lead_call_number',
  'start_hot_lead_call_verification',
  'confirm_hot_lead_call_verification',
  'list_smartlead_campaigns',
  'get_smartlead_campaign_stats',
  'preview_smartlead_push',
  'start_smartlead_push',
  'get_smartlead_push_status',
  'pause_smartlead_push',
  'resume_smartlead_push',
  'cancel_smartlead_push',
  'release_leads_from_smartlead',
  // A Luma key can be shared with the whole org (ENG-2737). A share-link visitor runs as the link's owner, so these would reach
  // every org-shared key, guests' registration answers and phone numbers included.
  'luma_list_events',
  'luma_get_guests',
  'save_org_memory',
  'delete_org_memory',
  'save_memory',
  'delete_memory',
]);

/**
 * ENG-3170: SENSITIVE actions. A share-link visitor runs as the owner, and a few tools are guarded only by a sentence in the prompt or
 * a `confirm` flag the model sets itself, so the visitor is the "user" who confirms. Sensitive means the call can
 *   1. permanently delete the owner's data,
 *   2. send, post or publish to people or the public outside the account,
 *   3. start, change or stop ad spend, or
 *   4. disconnect or revoke a connected account.
 * Unlike the block list above, whether a visitor may run these is the OWNER's choice per link (`allowSensitiveActions` on the link,
 * see `utils/interactiveShare.interactiveShareAllowsSensitiveActions`): off by default, and nothing is removed for an owner who turns
 * it on. The link's setting is read where the tool runs (`agentModeService.executeTool`); this module only says WHAT is sensitive and
 * how the refusal reads. A schedule a visitor set up has no link to ask, so it is always refused these (until the owner adopts it).
 *
 * Whole-tool entries are sensitive on every use. A tool that mixes reads and writes through one argument is listed with the argument's
 * READ values; any other value, a missing argument or an unreadable one is sensitive (a new write action must never be allowed by
 * accident). `__tests__/shareVisitorSensitiveTools.test.ts` pins this list and fails when a registered tool whose name looks outward
 * facing is neither listed here nor on the reviewed-safe list, so a new tool has to be classified by whoever adds it.
 */
export const SHARE_VISITOR_SENSITIVE_TOOLS: ReadonlySet<string> = new Set<string>([
  // 1. permanently delete the owner's data
  'delete_leads',
  'delete_lead_list',
  'delete_leads_by_filter',
  'delete_gtm_items',
  'delete_character',
  'delete_landing_page',
  'regenerate_market_strategy', // its own description says DESTRUCTIVE: it replaces the competitors and ICPs
  'google_calendar_delete_event', // cannot be undone, and by default tells the attendees
  // 4. disconnect or revoke a connected account
  'revoke_linkedin_account',
  // 2. send, post or publish to people or the public outside the account
  'slack_send_message',
  'send_email_from_sender',
  'send_email_to_lead',
  'send_gtm_status_report',
  'notify_session', // emails any address it is given
  'post_on_connected_account', // LinkedIn, Instagram, YouTube, X
  'publish_blog_article',
  'publish_landing_page_changes', // merges into main and deploys to production
  'revert_landing_page_publish',
  'enable_session_tracking', // commits the tracking tag to the customer's own repo
  // 3. start or change ad spend (Meta writes through call_meta_marketing_api are already behind an approval deck a visitor can not answer)
  'launch_targeted_audience_campaign',
  'launch_retargeting_campaign',
]);

/**
 * A tool that mixes reads and sensitive writes is judged by one argument.
 *  - `action`: the argument that says what the call does. A value is allowed (even when sensitive actions are off) when it is in
 *    `allowedValues` or starts with one of `allowedPrefixes`; EVERY other value, a missing argument and a non-text one is sensitive, so
 *    a write action added tomorrow is refused until someone classifies it. Values are compared trimmed, lower-cased, with `_` as `-`
 *    (the X and LinkedIn dispatchers treat them the same).
 *  - `present`: the call is sensitive when any of these arguments is set (a non-empty text or list, or `true`), because that is what
 *    makes the tool reach someone (calendar attendees, a notification, a document shared with addresses).
 * All the read actions of the tools below are get-, list- or search-... (checked against the action literals in
 * `emma/impl/adsCrmApis.ts`, `adsApis.ts`, `linkedin.ts`, `twitter.ts`); `shareVisitorSensitiveTools.test.ts` pins that against the
 * live tool schemas.
 */
export type SensitiveByArgument =
  | { kind: 'action'; argument: string; allowedValues?: readonly string[]; allowedPrefixes?: readonly string[] }
  | { kind: 'present'; arguments: readonly string[] };

const READ_PREFIXES: readonly string[] = ['get', 'list', 'search'];

export const SHARE_VISITOR_SENSITIVE_BY_ARGUMENT: Readonly<Record<string, SensitiveByArgument>> = {
  email: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // send is the write
  linkedin_outreach: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // send-invite, send-message, send-inmail, accept/cancel/withdraw invitations
  linkedin_manage_post: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // repost, comment, react, delete_post
  twitter_manage_post: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // reply, post_thread, quote_tweet, delete_tweet, like, retweet...
  twitter_outreach: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // send_dm, follow, block, mute...
  call_google_ads_api: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // create, update, pause, resume, remove, upload... change spend
  call_hubspot_api: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // publish, create_broadcast, delete, add/remove contacts...
  call_attio_api: { kind: 'action', argument: 'action', allowedValues: ['count'], allowedPrefixes: READ_PREFIXES },
  call_linkedin_marketing_api: { kind: 'action', argument: 'action', allowedValues: ['estimate-reach'], allowedPrefixes: READ_PREFIXES },
  // create and update are handled by schedule provenance (ENG-2816); a toggle is reversible; DELETE removes the owner's schedule
  manage_scheduled_chat: { kind: 'action', argument: 'action', allowedValues: ['create', 'update', 'toggle'] },
  google_calendar_create_event: { kind: 'present', arguments: ['attendees'] },
  google_calendar_update_event: { kind: 'present', arguments: ['attendees'] },
  update_gtm_work_item: { kind: 'present', arguments: ['notify_user', 'notify_item_poc', 'notify_phase_poc', 'notify_plan_poc'] },
  create_google_doc: { kind: 'present', arguments: ['share_with_emails'] },
  create_google_sheet: { kind: 'present', arguments: ['share_with_emails'] },
};

function normaliseActionValue(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function isSet(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/** True when this call is sensitive (see above). Pure: it does not know about any link, only about the tool and its arguments. */
export function isSensitiveToolCall(toolName: string, args?: unknown): boolean {
  if (typeof toolName !== 'string') return false;
  if (SHARE_VISITOR_SENSITIVE_TOOLS.has(toolName)) return true;
  // Own keys only: a tool called "constructor" must not read as an entry on Object.prototype.
  if (!Object.prototype.hasOwnProperty.call(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT, toolName)) return false;
  const rule = SHARE_VISITOR_SENSITIVE_BY_ARGUMENT[toolName];
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (rule.kind === 'present') return rule.arguments.some((name) => isSet(record[name]));
  const raw = record[rule.argument];
  if (typeof raw !== 'string') return true;
  const value = normaliseActionValue(raw);
  if (rule.allowedValues?.includes(value)) return false;
  if (rule.allowedPrefixes?.some((prefix) => value.startsWith(prefix))) return false;
  return true;
}

/** The refusal for a visitor on a link where the owner has not allowed sensitive actions. The share-session eval keys on "is not available in shared sessions". */
export function sensitiveActionRefusal(toolName: string): string {
  return `Tool "${toolName}" can delete data, send or post to people outside the account, change ad spend or disconnect an account, and the owner has not allowed that for this shared link, so it is not available in shared sessions. Tell the person this action is switched off for this link and that the owner can allow it in the share settings, or do it in Agent Mode in their own session.`;
}

/** Same refusal for a scheduled run of a schedule a visitor set up or edited (there is no link to ask): the owner adopts the schedule to lift it. */
export function sensitiveActionScheduleRefusal(toolName: string): string {
  return `Tool "${toolName}" can delete data, send or post to people outside the account, change ad spend or disconnect an account, and is not available in this scheduled run because this schedule was set up or edited through a share link. The owner can adopt the schedule in the portal to lift this limit.`;
}

/** Thrown when the link a visitor's call belongs to could not be read, so it cannot be shown that the owner allowed the action. */
export function sensitiveActionUnverifiableRefusal(toolName: string): string {
  return `Tool "${toolName}" was not run: whether the owner allowed sensitive actions on this shared link could not be verified just now, so it was refused rather than assumed safe. Nothing was done. It will work again once the link can be read.`;
}

interface RestrictionProfile {
  /**
   * The refusal text for a tool this profile forbids, or null when the profile allows it. `args` lets a profile refuse only some uses
   * of a tool. With `nameOnly` it answers for the tool NAME alone: only a tool refused whatever its arguments, never one refused for
   * some of its actions (for a caller that has no call in hand, such as which required calls a schedule can be held to).
   */
  refusal(toolName: string, adminToolNames: readonly string[], args?: unknown, nameOnly?: boolean): string | null;
}

/** Which kind of tool a restricted principal is refused, so two profiles can share a block list and differ only in their wording. */
function classifyRestrictedTool(toolName: string, adminToolNames: readonly string[]): 'admin' | 'owner_settings' | 'connect_account' | null {
  if (adminToolNames.includes(toolName)) return 'admin';
  if (SHARE_VISITOR_BLOCKED_TOOLS.has(toolName)) return 'owner_settings';
  if (toolName === 'connect_account') return 'connect_account';
  return null;
}

const PROFILES: Record<RestrictionProfileId, RestrictionProfile> = {
  share_visitor: {
    // The wording is relied on: the share-session refusal eval keys on "is not available in shared sessions".
    refusal(toolName, adminToolNames) {
      if (adminToolNames.includes(toolName)) {
        return `Tool "${toolName}" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.`;
      }
      if (SHARE_VISITOR_BLOCKED_TOOLS.has(toolName)) {
        return `Tool "${toolName}" acts on the owner's organization settings or memory and is not available in shared sessions. The owner can use it in Agent Mode in their own session.`;
      }
      if (toolName === 'connect_account') {
        return 'Account connections are not available in shared sessions. Tell the user they need to open Agent Mode in their own account to connect this account, then come back here.';
      }
      return null;
    },
  },
  // ENG-2816 step 3: the same block list for a scheduled run of a schedule a share-link visitor set up or edited. The wording
  // names the reason (the schedule, not the chat) and the way out (the owner adopts it), because the person reading this is
  // the owner looking at a scheduled run's result, not a visitor in a shared chat.
  share_visitor_schedule: {
    refusal(toolName, adminToolNames, args, nameOnly) {
      const reason = 'because this schedule was set up or edited through a share link';
      const way = 'The owner can adopt the schedule in the portal to lift this limit.';
      // ENG-3170: no link to ask, so a visitor-made schedule never runs a sensitive action until the owner adopts it.
      if (nameOnly ? SHARE_VISITOR_SENSITIVE_TOOLS.has(toolName) : isSensitiveToolCall(toolName, args)) return sensitiveActionScheduleRefusal(toolName);
      switch (classifyRestrictedTool(toolName, adminToolNames)) {
        case 'admin':
          return `Tool "${toolName}" is not available in this scheduled run ${reason}. ${way}`;
        case 'owner_settings':
          return `Tool "${toolName}" acts on the owner's organization settings or memory and is not available in this scheduled run ${reason}. ${way}`;
        case 'connect_account':
          return `Account connections are not available in this scheduled run ${reason}. ${way} Or the owner can connect the account in their own session.`;
        default:
          return null;
      }
    },
  },
};

/** True for an id this module defines. Own keys only: "constructor" must not read as a profile. */
export function isKnownRestrictionProfile(value: unknown): value is RestrictionProfileId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

/**
 * The profile a restriction CLAIM names, where a claim is a value that travels with a self-call (the `_rp` claim of a self-call
 * token, or the `restrictionProfile` of a tool context on its way into one). Absent means no claim. A known id is itself. A claim
 * that is PRESENT but not a known id is read as the strictest known profile, not as no claim: whoever put it there meant to
 * restrict, and a stale or mistyped id must never loosen anything (the same rule `restrictionRefusal` applies).
 */
export function normalizeRestrictionClaim(value: unknown): RestrictionProfileId | undefined {
  if (value === undefined || value === null || value === false || value === '') return undefined;
  return isKnownRestrictionProfile(value) ? value : 'share_visitor';
}

/**
 * The refusal when a tool call could not be checked against its schedule's provenance (the session or schedule could not be read,
 * or the schedule is gone). Unverifiable is treated as marked: refusing costs one retry, running as the owner costs the hole.
 */
export function scheduleProvenanceUnverifiableRefusal(toolName: string): string {
  return `Tool "${toolName}" was not run: whether this schedule was set up or edited through a share link could not be verified just now, so it was refused rather than assumed safe. Nothing was done. It will work again on the next run once the schedule can be read.`;
}

/**
 * Thrown by `agentModeService.executeTool` when a restricted principal calls a tool its profile forbids. It is thrown, not
 * returned, like the sandbox guard next to it, so every caller shows it as the failure it is: live voice hands the message to
 * Gemini as an error and marks the tool card failed, and the dispatcher records an error outcome. (A returned failure object
 * would be summarised by voice as if the tool had run.)
 */
export class ToolRestrictionDenied extends Error {
  readonly deniedBy = 'restriction_profile' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ToolRestrictionDenied';
  }
}

/**
 * The refusal for `toolName` under `profile`, or null when it may run. No profile means no restriction.
 *
 * An unrecognised profile id is treated as the strictest known profile rather than as no restriction: a typo or a stale id
 * must never loosen anything.
 */
export function restrictionRefusal(
  profile: unknown,
  toolName: string,
  adminToolNames: readonly string[],
  args?: unknown,
  options?: { nameOnly?: boolean },
): string | null {
  if (profile === undefined || profile === null || profile === false || profile === '') return null;
  // Own keys only: an id such as "constructor" must not resolve to something on Object.prototype.
  const known = typeof profile === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, profile);
  const resolved = known ? PROFILES[profile as RestrictionProfileId] : PROFILES.share_visitor;
  return resolved.refusal(toolName, adminToolNames, args, options?.nameOnly === true);
}
