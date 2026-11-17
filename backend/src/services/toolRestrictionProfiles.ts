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

interface RestrictionProfile {
  /** The refusal text for a tool this profile forbids, or null when the profile allows it. */
  refusal(toolName: string, adminToolNames: readonly string[]): string | null;
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
    refusal(toolName, adminToolNames) {
      const reason = 'because this schedule was set up or edited through a share link';
      const way = 'The owner can adopt the schedule in the portal to lift this limit.';
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
export function restrictionRefusal(profile: unknown, toolName: string, adminToolNames: readonly string[]): string | null {
  if (profile === undefined || profile === null || profile === false || profile === '') return null;
  // Own keys only: an id such as "constructor" must not resolve to something on Object.prototype.
  const known = typeof profile === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, profile);
  const resolved = known ? PROFILES[profile as RestrictionProfileId] : PROFILES.share_visitor;
  return resolved.refusal(toolName, adminToolNames);
}
