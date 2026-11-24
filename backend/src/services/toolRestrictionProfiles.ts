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
 *   1. permanently delete or change the owner's data (including re-enabling contact with a lead who opted out, or opening a lead list to
 *      public submissions),
 *   2. send, post or publish to people or the public outside the account,
 *   3. start, change or stop ad spend,
 *   4. disconnect or revoke a connected account, or
 *   5. hand the owner's saved logins (passwords) to the model, or
 *   6. change what the owner set up (settings, Emma's memory, skills, plans, templates, schedules' timing and recipients) or start something that
 *      will run LATER as the owner (a task, a schedule, a decision a team approver settles).
 * Whether a visitor may run these is the OWNER's choice per link (`allowSensitiveActions` on the link, see
 * `utils/interactiveShare.interactiveShareAllowsSensitiveActions`; customers see it as "Full control"): off by default, and nothing is
 * removed for an owner who turns it on. Owner decision 2026-11-23: "full control means everything that the customer can do, like it
 * used to be before any of our changes/restrictions". So Full control also lifts the ENG-2816 block list above (owner settings, hot-lead
 * calls, Smartlead, Luma, memory) and `connect_account` for that link. ADMIN tools are never lifted: they are not something a customer can
 * do, and a link holder must never get staff powers. A schedule a visitor set up has no link to ask, so it keeps the whole block list. The link's setting is read where the tool runs (`agentModeService.executeTool`); this module only says WHAT is sensitive and
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
  'enable_lead_list_public_access', // opens the owner's lead list to unauthenticated submissions
  'set_landing_page_lead_list', // enables public submissions on a list and syncs the repo's capture route
  'delete_gtm_items',
  'delete_character',
  'delete_landing_page',
  'regenerate_market_strategy', // its own description says DESTRUCTIVE: it replaces the competitors and ICPs
  'google_calendar_delete_event', // cannot be undone, and by default tells the attendees
  // 4. disconnect or revoke a connected account
  'revoke_linkedin_account',
  // 5. hand the owner's saved logins to the model (the tool returns the decrypted password)
  'get_login_credentials',
  'get_test_account',
  'list_test_accounts', // the site, login and notes of every saved test login: the username half of get_test_account
  'open_site_signin', // uses a stored captcha-bypass key and opens a sign-in for the model, with the key in the page URL
  // 5b. the owner's saved browser sessions (the cookie jar the browser tools load automatically): load them into the browser, replace them, wipe them
  'load_browser_cookies',
  'save_browser_cookies',
  'clear_browser_cookies',
  'mark_browser_session_failed',
  // 5c. one-time login codes and magic links read from the owner's connected mailbox: with a browser, that is a log-in to a site as the owner
  'read_verification_code',
  // `email` (search, list, get, send): search and get return full message bodies from the owner's connected mailbox, which is how a visitor could read a
  // login code, magic link or password-reset mail that THEIR OWN browser just triggered for a site the owner has an account on; that is read_verification_code
  // by another name, so the whole tool is sensitive (send is the write)
  'email',
  // 5d. the OLD agent-engine task tools: the task runs under the owner's account in a real browser and reads the owner's own saved logins and
  // cookies there (`useSharedBrowser: false`), which the OFF rule refuses for the browser tools themselves
  'create_task_from_prompt',
  'create_task_from_template',
  'create_revision',
  'create_image_task_from_prompt', // the same task machinery as create_task_from_prompt, with the visitor's text inside the task
  // 6. what the owner set up inside the account (the approved wording: "change your settings or Emma's memory"): overwrite it
  'update_brand_guidelines',
  'update_market_strategy', // manage_market_strategy (read or update) is judged by its action, below
  'update_knowledge_base_file',
  'configure_lead_statuses',
  'update_lead_list', // name, filters and status stages
  'save_test_account', // stores a login in the owner's account
  'create_skill', // stores the caller's text as lasting instructions in the owner's library (offered to the owner and the org's members)
  'save_work_plan', // saves the caller's steps as a plan in the owner's library that the owner or teammates later launch
  'attach_knowledge_base_files', // Emma's memory: task runs and owner sessions read a task's knowledge base
  'create_knowledge_base',
  'create_html_template', // replaces the template the owner's emailed reports are built from (found by id or by an exact name)
  'create_book_outline', // replaces a book's whole outline: every existing chapter is cut off from it
  'update_google_doc', // replaces the whole body of any Google doc the owner can edit (full Drive scope), shared or published ones included
  'update_google_sheet', // overwrites ranges in any sheet the owner can edit; values are USER_ENTERED, so formulas run
  // 2. send, post or publish to people or the public outside the account
  'report_product_issues', // a feature request becomes a PUBLIC Featurebase post authored as the owner (a duplicate votes and comments as the owner); also emails AgentWeb's founders
  'write_clickup_doc', // a doc or page in the owner's ClickUp workspace, as the owner
  'create_clickup_task', // a task in any list of the owner's ClickUp, with assignees
  'coding_agent', // pushes code to the owner's PUBLIC preview branch, which the owner's next publish ships
  'generate_landing_page', // deploys a LIVE page (onto the owner's existing site by default), can open a lead list to public submissions and locks the owner's site mode
  'duplicate_landing_page', // regenerates and deploys a live copy
  'stage_pending_decision', // a decision a team approver settles RESUMES this session as a full owner turn (approvalInboxExecution.resumeOriginSession), with the visitor's messages in view; audience customer also emails any address
  'slack_send_message',
  'send_email_from_sender',
  'send_email_to_lead',
  'send_gtm_status_report',
  'notify_session', // emails any address it is given
  'post_on_connected_account', // LinkedIn, Instagram, YouTube, X
  'publish_blog_article',
  'publish_landing_page_changes', // merges into main and deploys to production
  'deploy_landing_page',
  'test_scheduled_chat', // runs one of the owner's saved schedules now and can email its configured recipients
  'revert_landing_page_publish',
  'enable_session_tracking', // commits the tracking tag to the customer's own repo
  // 3. start or change ad spend (Meta writes through call_meta_marketing_api are already behind an approval deck a visitor can not answer)
  'launch_targeted_audience_campaign',
  'launch_retargeting_campaign',
]);

/**
 * Tools that exist only at RUNTIME, from an external MCP server the owner's account runs with the owner's own token (the per-user GitHub server in
 * `mcp/client/mcp_config.ts`), so they are not in the static registry the guard test walks. Their WRITE tools are sensitive by name; their reads (get_,
 * list_, search_) are not listed. The names are the ones the server publishes (@modelcontextprotocol/server-github); `shareVisitorSensitiveTools.test.ts`
 * pins that none of them shadows a tool of ours. Servers an operator adds through the `mcp_servers` setting are not covered (a limit, in the dev note).
 */
export const SHARE_VISITOR_SENSITIVE_RUNTIME_TOOLS: ReadonlySet<string> = new Set<string>([
  'create_or_update_file',
  'push_files',
  'create_repository',
  'fork_repository',
  'create_branch',
  'create_issue',
  'update_issue',
  'add_issue_comment',
  'create_pull_request',
  'merge_pull_request',
  'update_pull_request_branch',
  'create_pull_request_review',
  'delete_file',
]);

/**
 * A tool that mixes reads and sensitive writes is judged by one argument.
 *  - `action`: the argument that says what the call does. A value is allowed (even when sensitive actions are off) when it is in
 *    `allowedValues` or starts with one of `allowedPrefixes`; EVERY other value, a missing argument and a non-text one is sensitive, so
 *    a write action added tomorrow is refused until someone classifies it. Values are compared trimmed, lower-cased, with `_` as `-`
 *    (the X and LinkedIn dispatchers treat them the same).
 *  - `present`: the call is sensitive when any of these arguments is set (a non-empty text or list, or any other truthy value), because that is what
 *    makes the tool reach someone (calendar attendees, a notification, a document shared with addresses).
 * All the read actions of the tools below are get-, list- or search-... (checked against the action literals in
 * `emma/impl/adsCrmApis.ts`, `adsApis.ts`, `linkedin.ts`, `twitter.ts`); `shareVisitorSensitiveTools.test.ts` pins that against the
 * live tool schemas.
 */
export type SensitiveByArgument =
  | {
      kind: 'action';
      argument: string;
      allowedValues?: readonly string[];
      allowedPrefixes?: readonly string[];
      /**
       * An allowed `action` value that is only allowed with another argument at one of these values (compared the same way). Anything else,
       * a missing or a non-text argument included, makes that call sensitive. Used for a toggle that is safe to PAUSE but not to resume.
       */
      alsoRequire?: Readonly<Record<string, { argument: string; allowedValues: readonly string[] }>>;
      /**
       * An allowed `action` value that is sensitive as soon as ANY of these arguments is set (non-empty text or list, or any other truthy value).
       * Used for an `update` that is fine for the fields the schedule provenance tracks but would also re-time or re-model a schedule that is
       * the owner's own, which leaves no visitor mark.
       */
      forbidWhenSet?: Readonly<Record<string, readonly string[]>>;
    }
  | { kind: 'present'; arguments: readonly string[] };

const READ_PREFIXES: readonly string[] = ['get', 'list', 'search'];

export const SHARE_VISITOR_SENSITIVE_BY_ARGUMENT: Readonly<Record<string, SensitiveByArgument>> = {
  linkedin_outreach: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // send-invite, send-message, send-inmail, accept/cancel/withdraw invitations
  linkedin_manage_post: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // repost, comment, react, delete_post
  twitter_manage_post: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // reply, post_thread, quote_tweet, delete_tweet, like, retweet...
  twitter_outreach: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // send_dm, follow, block, mute...
  call_google_ads_api: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // create, update, pause, resume, remove, upload... change spend
  call_hubspot_api: { kind: 'action', argument: 'action', allowedPrefixes: READ_PREFIXES }, // publish, create_broadcast, delete, add/remove contacts...
  call_attio_api: { kind: 'action', argument: 'action', allowedValues: ['count'], allowedPrefixes: READ_PREFIXES },
  call_linkedin_marketing_api: { kind: 'action', argument: 'action', allowedValues: ['estimate-reach'], allowedPrefixes: READ_PREFIXES },
  // create and update are handled by schedule provenance (ENG-2816). A toggle writes no visitor mark, so RESUMING a paused schedule of the
  // owner's would let it run again, unrestricted, as the owner (it can email or post): only pausing is allowed. DELETE removes the owner's schedule.
  // An UPDATE that touches only what the provenance tracks (prompt, recipients, variables...) is marked and judged; one that re-times or re-models a
  // schedule leaves no mark (timing is untracked on purpose, utils/scheduleProvenance.ts), so on the owner's own schedule it would make it run now or
  // far more often, unrestricted. Those fields make an update sensitive.
  manage_scheduled_chat: {
    kind: 'action',
    argument: 'action',
    allowedValues: ['create', 'update', 'toggle'],
    alsoRequire: { toggle: { argument: 'status', allowedValues: ['paused'] } },
    // email_notifications: the result of every run is emailed to those addresses by AgentWeb, whatever tools the run may use
    forbidWhenSet: {
      create: ['email_notifications'],
      update: ['email_notifications', 'schedule_frequency', 'frequency_interval_days', 'next_run_time', 'timezone', 'run_count', 'llm_model', 'backup_model', 'daily_digest'],
    },
  },
  // Submitting variables only changes tracked fields (marked), but trigger_run starts the owner's schedule right now, paused or not, with no mark.
  submit_scheduled_chat_variables: { kind: 'present', arguments: ['trigger_run'] },
  // The market strategy tool reads and updates through one argument; its update replaces the owner's business overview and merges competitors and ICPs.
  manage_market_strategy: { kind: 'action', argument: 'action', allowedValues: ['read'] },
  // setting a lead to do-not-contact or unsubscribed only restricts outreach; 'active' clears the flag and allows contact again
  set_lead_contact_status: { kind: 'action', argument: 'contact_status', allowedValues: ['do-not-contact', 'unsubscribed'] },
  google_calendar_create_event: { kind: 'present', arguments: ['attendees'] },
  google_calendar_update_event: { kind: 'present', arguments: ['attendees'] },
  // `dri` is an email address: every later status report and update notice of the plan goes to it, so a visitor naming an address makes the owner's next report reach it
  update_gtm_work_item: { kind: 'present', arguments: ['notify_user', 'notify_item_poc', 'notify_phase_poc', 'notify_plan_poc', 'dri'] },
  update_gtm_plan: { kind: 'present', arguments: ['dri'] },
  add_gtm_phase: { kind: 'present', arguments: ['dri'] },
  create_gtm_plan: { kind: 'present', arguments: ['dri'] },
  update_gtm_phase: { kind: 'present', arguments: ['dri'] },
  // an `autocomplete` plan tells later turns to carry on without pausing, so steps a visitor wrote run unattended in the owner's next turn
  create_work_plan: { kind: 'present', arguments: ['autocomplete'] },
  modify_work_plan: { kind: 'present', arguments: ['autocomplete'] },
  // the recipients a schedule's results are emailed to (the visitor mark restricts the TOOLS a run may use, not who receives the emailed result)
  create_schedule_from_template: { kind: 'present', arguments: ['email_notifications'] },
  create_google_doc: { kind: 'present', arguments: ['share_with_emails'] },
  create_google_sheet: { kind: 'present', arguments: ['share_with_emails'] },
};

/**
 * Calls that are sensitive ONLY in a scheduled run of a schedule a visitor wrote (the `share_visitor_schedule` profile), not in a visitor's own chat. A Meta
 * write in a visitor's chat halts into an approval deck that only the owner can answer (unless Full control is on); in an UNATTENDED run the same write is
 * staged as an Approval Desk decision that AgentWeb's own approver can approve, without the owner, and the write is then sent with the owner's Meta token.
 * So a schedule a visitor wrote may read the ad account but never write to it (the owner adopting the schedule lifts this).
 */
export const SHARE_VISITOR_SCHEDULE_ONLY_SENSITIVE_BY_ARGUMENT: Readonly<Record<string, SensitiveByArgument>> = {
  call_meta_marketing_api: { kind: 'action', argument: 'action', allowedValues: ['preview'], allowedPrefixes: READ_PREFIXES },
};

/** True when this call is sensitive in a scheduled run of a visitor-made schedule (see above). Pure. */
export function isSensitiveInVisitorScheduleCall(toolName: string, args?: unknown): boolean {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(SHARE_VISITOR_SCHEDULE_ONLY_SENSITIVE_BY_ARGUMENT, toolName)) return false;
  const rule = SHARE_VISITOR_SCHEDULE_ONLY_SENSITIVE_BY_ARGUMENT[toolName];
  if (rule.kind !== 'action') return false;
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const raw = record[rule.argument];
  if (typeof raw !== 'string') return true;
  const value = normaliseActionValue(raw);
  if (rule.allowedValues?.includes(value)) return false;
  if (rule.allowedPrefixes?.some((prefix) => value.startsWith(prefix))) return false;
  return true;
}

function normaliseActionValue(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

/** "Set" the way the tools read it: a non-empty list or text, or any other truthy value (a tool that notifies on a truthy flag is reached by `1` or `{}` too). */
function isSet(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** True for a tool that is sensitive whatever its arguments (the whole-tool list). A tool judged by an argument is not: it needs the call. */
export function isSensitiveWholeTool(toolName: string): boolean {
  return typeof toolName === 'string' && (SHARE_VISITOR_SENSITIVE_TOOLS.has(toolName) || SHARE_VISITOR_SENSITIVE_RUNTIME_TOOLS.has(toolName));
}

/**
 * True for a tool whose use by a share-link visitor depends on the link's full-control choice whatever its arguments: a whole-tool
 * sensitive entry, the ENG-2816 block list (owner settings, memory, Smartlead, Luma, hot-lead calls) or `connect_account`. Admin tools
 * are NOT here: they are refused for a visitor on every link.
 */
export function isFullControlGatedWholeTool(toolName: string): boolean {
  return typeof toolName === 'string'
    && (isSensitiveWholeTool(toolName) || SHARE_VISITOR_BLOCKED_TOOLS.has(toolName) || toolName === 'connect_account');
}

/** True when this call is sensitive (see above). Pure: it does not know about any link, only about the tool and its arguments. */
export function isSensitiveToolCall(toolName: string, args?: unknown): boolean {
  if (typeof toolName !== 'string') return false;
  if (isSensitiveWholeTool(toolName)) return true;
  // Own keys only: a tool called "constructor" must not read as an entry on Object.prototype.
  if (!Object.prototype.hasOwnProperty.call(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT, toolName)) return false;
  const rule = SHARE_VISITOR_SENSITIVE_BY_ARGUMENT[toolName];
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (rule.kind === 'present') return rule.arguments.some((name) => isSet(record[name]));
  const raw = record[rule.argument];
  if (typeof raw !== 'string') return true;
  const value = normaliseActionValue(raw);
  if (rule.allowedValues?.includes(value)) {
    const forbidden = Object.prototype.hasOwnProperty.call(rule.forbidWhenSet ?? {}, value) ? rule.forbidWhenSet?.[value] : undefined;
    if (forbidden?.some((name) => isSet(record[name]))) return true;
    const extra = Object.prototype.hasOwnProperty.call(rule.alsoRequire ?? {}, value) ? rule.alsoRequire?.[value] : undefined;
    if (!extra) return false;
    const other = record[extra.argument];
    return !(typeof other === 'string' && extra.allowedValues.includes(normaliseActionValue(other)));
  }
  if (rule.allowedPrefixes?.some((prefix) => value.startsWith(prefix))) return false;
  return true;
}

/** The refusal for a visitor on a link where the owner has not turned on full control. The share-session eval keys on "is not available in shared sessions". */
export function sensitiveActionRefusal(toolName: string): string {
  return `Tool "${toolName}" can delete or change data, change the owner's settings or memory, connect accounts, send or post to people outside the account, change ad spend, disconnect an account or use saved logins, and the owner has not turned on full control for this shared link, so it is not available in shared sessions. Tell the person this is switched off for this link and that the owner can turn on full control in the share settings, or do it in Agent Mode in their own session.`;
}

/** Same refusal for a scheduled run of a schedule a visitor set up or edited (there is no link to ask): the owner adopts the schedule to lift it. */
export function sensitiveActionScheduleRefusal(toolName: string): string {
  return `Tool "${toolName}" can delete or change data, change the owner's settings or memory, connect accounts, send or post to people outside the account, change ad spend, disconnect an account or use saved logins, and is not available in this scheduled run because this schedule was set up or edited through a share link. The owner can adopt the schedule in the portal to lift this limit.`;
}

/** Thrown when the link a visitor's call belongs to could not be read, so it cannot be shown that the owner turned on full control. */
export function sensitiveActionUnverifiableRefusal(toolName: string): string {
  return `Tool "${toolName}" was not run: whether the owner turned on full control for this shared link could not be verified just now, so it was refused rather than assumed safe. Nothing was done. It will work again once the link can be read.`;
}

interface RestrictionProfile {
  /**
   * The refusal text for a tool this profile forbids, or null when the profile allows it. `args` lets a profile refuse only some uses
   * of a tool. With `nameOnly` it answers for the tool NAME alone: only a tool refused whatever its arguments, never one refused for
   * some of its actions (for a caller that has no call in hand, such as which required calls a schedule can be held to).
   */
  refusal(toolName: string, adminToolNames: readonly string[], args?: unknown, nameOnly?: boolean, linkAllowsFullControl?: boolean): string | null;
}

/** Which kind of tool a restricted principal is refused, so two profiles can share a block list and differ only in their wording. */
function classifyRestrictedTool(toolName: string, adminToolNames: readonly string[]): 'admin' | 'owner_settings' | 'connect_account' | null {
  if (adminToolNames.includes(toolName)) return 'admin';
  if (SHARE_VISITOR_BLOCKED_TOOLS.has(toolName)) return 'owner_settings';
  if (toolName === 'connect_account') return 'connect_account';
  return null;
}

/**
 * True when the visitor-made-schedule profile refuses this tool because of the ENG-2816 block list (owner settings, memory, Smartlead,
 * admin tools, connect_account), as opposed to the ENG-3170 sensitive rule. The caller that already has its own answer for publishing
 * (`agentModeService.blockedByScheduledPublishApproval`) uses this to leave the block-listed tools to this module.
 */
export function isRefusedByScheduleBlockList(toolName: string, adminToolNames: readonly string[]): boolean {
  return classifyRestrictedTool(toolName, adminToolNames) !== null;
}

const PROFILES: Record<RestrictionProfileId, RestrictionProfile> = {
  share_visitor: {
    // The wording is relied on: the share-session refusal eval keys on "is not available in shared sessions".
    refusal(toolName, adminToolNames, _args, _nameOnly, linkAllowsFullControl) {
      // Admin tools are never lifted: a link holder must not get staff powers, whatever the owner chose.
      if (adminToolNames.includes(toolName)) {
        return `Tool "${toolName}" is not available in shared sessions. You can continue to use it in Agent Mode in your own session.`;
      }
      // ENG-3170: on a link whose owner turned on full control the rest of the block list is lifted.
      if (linkAllowsFullControl === true) return null;
      if (SHARE_VISITOR_BLOCKED_TOOLS.has(toolName)) {
        // Wording kept byte for byte: the share-session refusal eval depends on it.
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
      if (nameOnly ? isSensitiveWholeTool(toolName) : (isSensitiveToolCall(toolName, args) || isSensitiveInVisitorScheduleCall(toolName, args))) return sensitiveActionScheduleRefusal(toolName);
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
  options?: { nameOnly?: boolean; linkAllowsFullControl?: boolean },
): string | null {
  if (profile === undefined || profile === null || profile === false || profile === '') return null;
  // Own keys only: an id such as "constructor" must not resolve to something on Object.prototype.
  const known = typeof profile === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, profile);
  const resolved = known ? PROFILES[profile as RestrictionProfileId] : PROFILES.share_visitor;
  return resolved.refusal(toolName, adminToolNames, args, options?.nameOnly === true, options?.linkAllowsFullControl === true);
}
