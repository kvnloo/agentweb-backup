import {
  SHARE_VISITOR_SENSITIVE_TOOLS,
  SHARE_VISITOR_SENSITIVE_BY_ARGUMENT,
  SHARE_VISITOR_BLOCKED_TOOLS,
  SHARE_VISITOR_SCHEDULE_PROFILE,
  isSensitiveToolCall,
  isFullControlGatedWholeTool,
  restrictionRefusal,
  sensitiveActionRefusal,
  sensitiveActionScheduleRefusal,
  sensitiveActionUnverifiableRefusal,
} from '../services/toolRestrictionProfiles';
import { AgentModeService, ADMIN_SKILL_TOOL_NAMES } from '../services/agentModeService';

/**
 * ENG-3170: which tool calls are SENSITIVE (delete the owner's data, send or post outside the account, change ad spend, disconnect an
 * account), and a guard that keeps that list true to the real tool registry.
 *
 * A share-link visitor runs as the owner, and these tools are guarded only by a sentence in the prompt or a flag the model sets
 * itself. Whether a visitor may run them is the owner's per-link choice; this file pins WHAT counts, so a tool nobody classified can not
 * slip through, and a name that no longer exists can not sit in the list pretending to protect something.
 */

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({
    put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })) },
  S3: jest.fn(() => ({ upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }), getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  config: { update: jest.fn() },
}));
jest.mock('axios', () => {
  const instance = { get: jest.fn(), post: jest.fn(), request: jest.fn(), defaults: { headers: { common: {}, post: {} } }, interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } } };
  return { get: jest.fn(), post: jest.fn(), create: jest.fn(() => instance) };
});
jest.mock('../services/emailService', () => ({ emailService: { sendSessionNotificationEmail: jest.fn().mockResolvedValue({ sent: true, duplicate: false }) } }));

describe('isSensitiveToolCall (what counts as sensitive)', () => {
  it('every whole-tool entry is sensitive whatever its arguments', () => {
    for (const tool of SHARE_VISITOR_SENSITIVE_TOOLS) {
      for (const args of [undefined, null, {}, { action: 'list' }, 'text', 42]) {
        expect(isSensitiveToolCall(tool, args)).toBe(true);
      }
    }
  });

  it('pins the whole-tool list, so a change to it is a decision made on purpose', () => {
    expect([...SHARE_VISITOR_SENSITIVE_TOOLS].sort()).toEqual([
      'delete_character', 'delete_gtm_items', 'delete_landing_page', 'delete_lead_list', 'delete_leads', 'delete_leads_by_filter',
      'deploy_landing_page', 'enable_lead_list_public_access', 'enable_session_tracking', 'get_login_credentials', 'get_test_account',
      'google_calendar_delete_event',
      'launch_retargeting_campaign', 'launch_targeted_audience_campaign',
      'clear_browser_cookies', 'load_browser_cookies', 'mark_browser_session_failed', 'save_browser_cookies',
      'notify_session', 'post_on_connected_account', 'publish_blog_article', 'publish_landing_page_changes',
      'regenerate_market_strategy', 'revert_landing_page_publish', 'revoke_linkedin_account',
      'send_email_from_sender', 'send_email_to_lead', 'send_gtm_status_report', 'set_landing_page_lead_list', 'slack_send_message',
      'test_scheduled_chat',
    ].sort());
  });

  it('a tool that is not listed is not sensitive (the rule names tools, it does not guess from a name)', () => {
    for (const tool of ['read_brand_guidelines', 'list_leads', 'save_file', 'create_lead_list', 'generate_image', 'call_meta_marketing_api', 'send_for_review', 'unknown_tool']) {
      expect(isSensitiveToolCall(tool, { action: 'send' })).toBe(false);
    }
    // own keys only: a tool called "constructor" or "toString" is not an entry on Object.prototype
    expect(isSensitiveToolCall('constructor', {})).toBe(false);
    expect(isSensitiveToolCall('toString', {})).toBe(false);
    expect(isSensitiveToolCall('__proto__', {})).toBe(false);
  });

  describe('a tool that mixes reads and writes is judged by its action', () => {
    const mixed: Array<[string, string[], string[]]> = [
      // tool, reads, writes
      ['email', ['search', 'list', 'get'], ['send']],
      ['linkedin_outreach', ['search-people', 'get-profile', 'list-connections', 'list-sent-invitations', 'list-received-invitations', 'get-company', 'search-parameters', 'list-post-engagers'], ['send-invite', 'send-message', 'send-inmail', 'accept-invitation', 'cancel-invitation', 'withdraw-stale-invitations', 'set-daily-invite-cap', 'update-conversation-history']],
      ['linkedin_manage_post', ['list_comments', 'get_analytics'], ['repost', 'comment', 'react', 'delete_post']],
      ['twitter_manage_post', ['get_tweet_metrics', 'list_replies', 'get_retweeters', 'get_liking_users', 'get_quote_tweets'], ['reply', 'post_thread', 'quote_tweet', 'delete_tweet', 'like', 'unlike', 'retweet', 'unretweet']],
      ['twitter_outreach', ['get_profile', 'list_followers', 'list_following', 'search_tweets', 'get_user_tweets', 'list_dms', 'get_dm_conversation', 'get_bookmarks', 'get_liked_tweets', 'list_owned_lists', 'get_list_members', 'get_list_tweets'], ['send_dm', 'follow', 'unfollow', 'block', 'unblock', 'mute', 'unmute', 'bookmark']],
      ['call_google_ads_api', ['LIST', 'SEARCH'], ['CREATE', 'UPDATE', 'REMOVE', 'PAUSE', 'RESUME', 'ADD', 'ADD_NEGATIVE', 'ATTACH', 'UPLOAD', 'RETAG_UTM', 'ADD_PROXIMITY', 'REMOVE_PROXIMITY', 'SET_DEVICE_BID_ADJUSTMENT']],
      ['call_hubspot_api', ['LIST', 'GET', 'SEARCH', 'GET_STATS', 'GET_METRICS', 'GET_PERFORMANCE', 'GET_CONTACTS', 'GET_FORM_FIELDS', 'GET_SUBMISSIONS', 'LIST_ASSETS', 'LIST_BROADCASTS', 'LIST_CHANNELS', 'LIST_PIPELINES', 'LIST_SUBSCRIPTION_TYPES'], ['CREATE', 'UPDATE', 'DELETE', 'CLONE', 'PUBLISH', 'UNPUBLISH', 'ADD_ASSET', 'REMOVE_ASSET', 'ADD_CONTACTS', 'REMOVE_CONTACTS', 'ENABLE', 'DISABLE', 'SUBMIT', 'CREATE_BROADCAST', 'DELETE_BROADCAST']],
      ['call_attio_api', ['SEARCH', 'COUNT', 'LIST', 'GET'], ['ADD_ENTRIES', 'REMOVE_ENTRIES', 'CREATE']],
      ['call_linkedin_marketing_api', ['LIST', 'GET', 'LIST_FACETS', 'SEARCH', 'ESTIMATE_REACH'], ['CREATE', 'CREATE_INLINE', 'CREATE_DYNAMIC', 'UPDATE', 'RETAG_UTM', 'SEND_TEST', 'CREATE_CONTENT', 'SET_FIRST_CONTENT', 'INIT_IMAGE_UPLOAD', 'INIT_VIDEO_UPLOAD', 'UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'UPLOAD_DOCUMENT', 'FINALIZE_VIDEO']],
      ['manage_scheduled_chat', ['create', 'update', 'toggle'], ['delete']],
      // setting do-not-contact or unsubscribed only restricts outreach; 'active' clears the flag and allows contact again
      ['set_lead_contact_status', ['do-not-contact', 'unsubscribed'], ['active']],
      // a decision for the team is internal; one for a customer emails the named address from AgentWeb with the caller's text and link
      ['stage_pending_decision', ['team'], ['customer', 'Customer ', 'anyone', '']],
    ];

    it.each(mixed)('%s: its reads are allowed and its writes are sensitive', (tool, reads, writes) => {
      const argument = tool === 'set_lead_contact_status' ? 'contact_status' : tool === 'stage_pending_decision' ? 'audience' : 'action';
      for (const action of reads) expect({ tool, action, sensitive: isSensitiveToolCall(tool, { [argument]: action }) }).toEqual({ tool, action, sensitive: false });
      for (const action of writes) expect({ tool, action, sensitive: isSensitiveToolCall(tool, { [argument]: action }) }).toEqual({ tool, action, sensitive: true });
    });

    it('is not fooled by case, spacing or hyphen versus underscore', () => {
      expect(isSensitiveToolCall('linkedin_outreach', { action: '  SEND_Invite ' })).toBe(true);
      expect(isSensitiveToolCall('linkedin_outreach', { action: 'Search_People' })).toBe(false);
      expect(isSensitiveToolCall('twitter_manage_post', { action: 'POST-THREAD' })).toBe(true);
      expect(isSensitiveToolCall('twitter_manage_post', { action: 'list-replies' })).toBe(false);
    });

    it('a missing, empty, non-text or unknown action is sensitive (fail closed)', () => {
      for (const tool of Object.entries(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT).filter(([, r]) => r.kind === 'action').map(([t]) => t)) {
        const arg = (SHARE_VISITOR_SENSITIVE_BY_ARGUMENT[tool] as { argument: string }).argument;
        for (const args of [undefined, null, {}, { [arg]: '' }, { [arg]: '   ' }, { [arg]: 7 }, { [arg]: ['list'] }, { [arg]: { x: 1 } }, { [arg]: 'brand-new-action' }, 'list']) {
          expect({ tool, args, sensitive: isSensitiveToolCall(tool, args) }).toEqual({ tool, args, sensitive: true });
        }
      }
    });

    it('an action hidden inside a wrapper object does not make a call look harmless', () => {
      expect(isSensitiveToolCall('call_hubspot_api', { params: { action: 'LIST' } })).toBe(true);
      expect(isSensitiveToolCall('call_hubspot_api', { action: 'LIST', params: { action: 'DELETE' } })).toBe(false); // the top-level value is what the tool reads
    });

    it('a prefix is not a loophole for a write that merely starts with a read word elsewhere in the name', () => {
      expect(isSensitiveToolCall('call_hubspot_api', { action: 'forget_contacts' })).toBe(true);
      expect(isSensitiveToolCall('call_hubspot_api', { action: 'budget_update' })).toBe(true);
      expect(isSensitiveToolCall('call_hubspot_api', { action: 'targets' })).toBe(true);
    });
  });

  describe('a tool that reaches someone only when an argument is set', () => {
    it.each([
      ['google_calendar_create_event', 'attendees', ['a@example.com'], []],
      ['google_calendar_update_event', 'attendees', ['a@example.com'], []],
      ['update_gtm_work_item', 'notify_user', true, false],
      ['update_gtm_work_item', 'notify_item_poc', true, false],
      ['update_gtm_work_item', 'notify_phase_poc', true, false],
      ['update_gtm_work_item', 'notify_plan_poc', true, false],
      ['create_google_doc', 'share_with_emails', ['a@example.com'], []],
      ['create_google_sheet', 'share_with_emails', ['a@example.com'], []],
    ])('%s is sensitive with %s set, and not otherwise', (tool, arg, set, unset) => {
      expect(isSensitiveToolCall(tool, { [arg]: set })).toBe(true);
      expect(isSensitiveToolCall(tool, { [arg]: unset })).toBe(false);
      expect(isSensitiveToolCall(tool, {})).toBe(false);
      expect(isSensitiveToolCall(tool, undefined)).toBe(false);
      expect(isSensitiveToolCall(tool, { [arg]: '' })).toBe(false);
      expect(isSensitiveToolCall(tool, { [arg]: null })).toBe(false);
    });
    it('"set" means truthy, the way the tools read it: a flag given as 1 or an object still notifies, 0 and false do not', () => {
      expect(isSensitiveToolCall('update_gtm_work_item', { notify_user: 1 })).toBe(true);
      expect(isSensitiveToolCall('update_gtm_work_item', { notify_plan_poc: {} })).toBe(true);
      expect(isSensitiveToolCall('update_gtm_work_item', { notify_user: 0 })).toBe(false);
      expect(isSensitiveToolCall('update_gtm_work_item', { notify_user: false })).toBe(false);
    });
    it('a text value counts as set (a single address given as text)', () => {
      expect(isSensitiveToolCall('create_google_doc', { share_with_emails: 'a@example.com' })).toBe(true);
    });
  });
});

describe('the restriction profiles and the sensitive rule', () => {
  it('the visitor profile does not decide this by itself: whether a visitor may is the link\'s choice, read where the tool runs', () => {
    for (const tool of SHARE_VISITOR_SENSITIVE_TOOLS) {
      expect(restrictionRefusal('share_visitor', tool, ADMIN_SKILL_TOOL_NAMES, {})).toBeNull();
    }
  });

  it('a schedule a visitor set up has no link to ask: every sensitive call is refused there, an ordinary one is not', () => {
    for (const tool of SHARE_VISITOR_SENSITIVE_TOOLS) {
      expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, tool, ADMIN_SKILL_TOOL_NAMES, {})).toBe(sensitiveActionScheduleRefusal(tool));
    }
    expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, 'call_hubspot_api', ADMIN_SKILL_TOOL_NAMES, { action: 'DELETE' })).toContain('adopt the schedule');
    expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, 'call_hubspot_api', ADMIN_SKILL_TOOL_NAMES, { action: 'LIST' })).toBeNull();
    expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, 'read_brand_guidelines', ADMIN_SKILL_TOOL_NAMES, {})).toBeNull();
  });

  it('a schedule\'s existing block list still reads the same (the new rule is checked first only for sensitive calls)', () => {
    for (const tool of SHARE_VISITOR_BLOCKED_TOOLS) {
      expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, tool, ADMIN_SKILL_TOOL_NAMES, {})).toContain('organization settings or memory');
    }
  });

  it('the visitor refusal keeps the wording the share-session eval keys on, and tells the person what to do', () => {
    expect(sensitiveActionRefusal('delete_leads')).toContain('is not available in shared sessions');
    expect(sensitiveActionRefusal('delete_leads')).toContain('owner can turn on full control in the share settings');
    expect(sensitiveActionRefusal('get_login_credentials')).toContain('use saved logins');
    expect(sensitiveActionScheduleRefusal('delete_leads')).toContain('The owner can adopt the schedule in the portal to lift this limit.');
    expect(sensitiveActionUnverifiableRefusal('delete_leads')).toContain('Nothing was done');
  });
});

describe('Full control: what depends on the link (owner, 2026-11-23: everything a customer can do, like before the restrictions)', () => {
  it('the sensitive tools, the whole ENG-2816 block list and connect_account depend on the link', () => {
    for (const tool of [...SHARE_VISITOR_SENSITIVE_TOOLS, ...SHARE_VISITOR_BLOCKED_TOOLS, 'connect_account']) {
      expect({ tool, gated: isFullControlGatedWholeTool(tool) }).toEqual({ tool, gated: true });
    }
  });

  it('admin tools do NOT depend on the link: they are refused for a visitor whatever the owner chose', () => {
    for (const tool of ADMIN_SKILL_TOOL_NAMES) expect({ tool, gated: isFullControlGatedWholeTool(tool) }).toEqual({ tool, gated: false });
  });

  it('ordinary tools and tools judged by an argument are not whole-tool gated', () => {
    for (const tool of ['read_brand_guidelines', 'list_leads', 'email', 'call_hubspot_api', 'google_calendar_create_event', 'unknown_tool', 'constructor']) {
      expect({ tool, gated: isFullControlGatedWholeTool(tool) }).toEqual({ tool, gated: false });
    }
  });

  it('a link with full control lifts the block list and connect_account, and never an admin tool', () => {
    for (const tool of [...SHARE_VISITOR_BLOCKED_TOOLS, 'connect_account']) {
      expect(restrictionRefusal('share_visitor', tool, ADMIN_SKILL_TOOL_NAMES, undefined, { linkAllowsFullControl: false })).not.toBeNull();
      expect(restrictionRefusal('share_visitor', tool, ADMIN_SKILL_TOOL_NAMES, undefined, { linkAllowsFullControl: true })).toBeNull();
    }
    for (const tool of ADMIN_SKILL_TOOL_NAMES) {
      expect(restrictionRefusal('share_visitor', tool, ADMIN_SKILL_TOOL_NAMES, undefined, { linkAllowsFullControl: true })).not.toBeNull();
    }
  });

  it('full control never lifts anything for a schedule a visitor made (there is no link to ask)', () => {
    for (const tool of [...SHARE_VISITOR_BLOCKED_TOOLS, 'connect_account', ...SHARE_VISITOR_SENSITIVE_TOOLS]) {
      expect(restrictionRefusal(SHARE_VISITOR_SCHEDULE_PROFILE, tool, ADMIN_SKILL_TOOL_NAMES, {}, { linkAllowsFullControl: true })).not.toBeNull();
    }
  });

  it('only a real true lifts it: anything else keeps the refusal', () => {
    for (const value of [undefined, false, 'true', 1, {}] as unknown[]) {
      expect(restrictionRefusal('share_visitor', 'save_memory', ADMIN_SKILL_TOOL_NAMES, undefined, { linkAllowsFullControl: value as boolean })).not.toBeNull();
    }
  });
});

/**
 * The guard against the real registry. A tool added tomorrow whose name looks outward facing must be classified by whoever adds it:
 * put it in SHARE_VISITOR_SENSITIVE_TOOLS / SHARE_VISITOR_SENSITIVE_BY_ARGUMENT, or in REVIEWED_NOT_SENSITIVE below with the reason.
 */
const REVIEWED_NOT_SENSITIVE: Record<string, string> = {
  // blocked for visitors already (owner settings, Smartlead, hot-lead calls, memory, connect_account): the block list, not this one
  update_lead_notification_settings: 'owner settings, on the visitor block list',
  get_lead_notification_settings: 'owner settings, on the visitor block list',
  provision_hot_lead_call_number: 'on the visitor block list',
  release_hot_lead_call_number: 'on the visitor block list',
  start_hot_lead_call_verification: 'on the visitor block list',
  confirm_hot_lead_call_verification: 'on the visitor block list',
  update_hot_lead_call_settings: 'on the visitor block list',
  get_hot_lead_call_settings: 'on the visitor block list',
  start_smartlead_push: 'on the visitor block list',
  pause_smartlead_push: 'on the visitor block list',
  resume_smartlead_push: 'on the visitor block list',
  cancel_smartlead_push: 'on the visitor block list',
  preview_smartlead_push: 'on the visitor block list',
  get_smartlead_push_status: 'on the visitor block list',
  release_leads_from_smartlead: 'on the visitor block list',
  delete_memory: 'on the visitor block list',
  delete_org_memory: 'on the visitor block list',
  // protected another way
  call_meta_marketing_api: 'every write halts into an approval deck; a visitor can answer it only on a link whose owner turned on Full control (the share route answers 403 otherwise)',
  manage_schedule_template: 'visitor writes are refused (ENG-2816)',
  create_schedule_from_template: 'a schedule a visitor creates is provenance-marked and runs under the visitor profile (ENG-2816)',
  submit_scheduled_chat_variables: 'covered by schedule provenance (ENG-2816)',
  // internal: nothing leaves the account, or nothing is lost
  find_or_lookup_email: 'a lookup',
  update_email_draft_for_lead: 'edits a draft inside the account',
  get_temp_email: 'a throwaway inbox for sign-ups',
  read_verification_code: 'a read',
  create_social_media_posts: 'builds an HTML file of posts; nothing is posted',
  get_deployment_status: 'a read',
  get_leads_needing_followup: 'a read',
  create_lead_list: 'adds data inside the account',
  add_leads_to_list: 'adds data inside the account',
  remove_image_background: 'image editing',
  remove_c2pa_from_image: 'image editing',
  send_for_review: 'sends to the owner\'s configured reviewer, and a result-link flow for an outside recipient relies on it',
  list_connected_account_posts: 'a read',
  list_connected_accounts: 'a read',
  launch_predefined_work_plan: 'writes the session\'s own work plan',
  report_product_issues: 'feedback to AgentWeb',
  enqueue_human_eval: 'an internal AgentWeb queue',
  fathom_route_action_items: 'creates tasks in the owner\'s own Notion or ClickUp (owner decision pending)',
  create_clickup_task: 'a task in the owner\'s own ClickUp (owner decision pending)',
  write_clickup_doc: 'a doc in the owner\'s own ClickUp (owner decision pending)',
  generate_landing_page: 'creates a new site in a private repo (owner decision pending)',
  duplicate_landing_page: 'copies a page (backend route not confirmed)',
  coding_agent: 'works on a staging branch and a preview (owner decision pending)',
  slack_get_recent_messages: 'a read of the owner\'s Slack (privacy, raised separately)',
  slack_get_thread_replies: 'a read of the owner\'s Slack (privacy, raised separately)',
  slack_list_channels: 'a read',
  get_post_analytics: 'a read',
  get_task_subscriber_metrics: 'a read',
  get_task_subscriber_engagement_events: 'a read',
  call_linkedin_ads_insights_api: 'a read',
  call_meta_ads_insights_api: 'a read',
  call_google_ads_reporting_api: 'a read',
  create_blog_article: 'creates a draft inside the account',
  create_character: 'adds data inside the account',
  add_characters: 'adds data inside the account',
  update_google_doc: 'edits a document inside the account',
  update_google_sheet: 'edits a sheet inside the account',
  // ENG-3170 review: found by widening the name pattern to the neutral verbs. Nothing here sends or posts anything; each edits data inside the account.
  // The first group overwrites what the owner set up (strategy, brand, knowledge base, statuses): whether an OFF link should refuse them is the owner's decision, not made yet.
  update_brand_guidelines: 'overwrites the owner\'s brand guidelines inside the account (owner decision pending)',
  update_market_strategy: 'overwrites the owner\'s market strategy inside the account (owner decision pending)',
  manage_market_strategy: 'edits the owner\'s market strategy inside the account (owner decision pending)',
  update_knowledge_base_file: 'edits a task\'s knowledge base inside the account (owner decision pending)',
  configure_lead_statuses: 'replaces a list\'s status stages inside the account (owner decision pending)',
  update_lead_list: 'edits a list\'s name, filters and status stages inside the account (owner decision pending)',
  save_test_account: 'stores a test login in the owner\'s own account (owner decision pending)',
  update_lead: 'edits a lead\'s fields inside the account; it can not set the do-not-contact flag, which is set_lead_contact_status',
  update_lead_status: 'records a lead\'s pipeline status (and the caller\'s draft) on the lead; sends nothing',
  update_gtm_phase: 'edits a phase of a GTM plan inside the account',
  update_gtm_plan: 'edits a GTM plan inside the account',
  update_book_content: 'edits a book inside the account',
  update_landing_page_context: 'edits a landing page\'s context inside the account',
  update_html_file: 'edits a file in the session\'s own workspace',
  save_file: 'writes a file in the session\'s own workspace',
  save_work_plan: 'saves a private work plan to the owner\'s library',
  read_market_strategy: 'a read (the name contains "mark")',
  load_connected_account_metrics: 'a read of a connected account\'s metrics',
  google_drive: 'creates folders in the owner\'s own drive',
};

// ENG-3170 review: the neutral verbs (clear, load, save, update, configure, manage, mark, stage) are in on purpose: a tool that wipes or replaces the owner's saved
// logins or settings has no outward-sounding word in its name, and a name-only pattern that misses it forces nobody to look.
const OUTWARD_NAME = /(send|post|publish|delete|remove|launch|revoke|disconnect|deploy|email|mail|notify|invite|follow|broadcast|share|sms|call_|_dm\b|message|reply|comment|tweet|webhook|outreach|revert|clear|load|save|update|configure|manage|mark|stage)/i;

function schemaOf(tool: any): any {
  const def = tool?.definition ?? {};
  return def.inputSchema ?? def.function?.parameters ?? def.parameters ?? tool?.inputSchema ?? {};
}

describe('the sensitive list against the real tool registry', () => {
  let tools: Map<string, any>;

  beforeAll(async () => {
    (AgentModeService as any).toolsRegistered = false;
    const service = new AgentModeService();
    await service.initialize();
    tools = new Map((service as any).toolRegistry.getAllTools().map((t: any) => [t.name ?? t.definition?.name ?? t.definition?.function?.name, t]));
  });

  it('every tool named in the sensitive list exists (a renamed tool must not leave a name that protects nothing)', () => {
    const missing = [...SHARE_VISITOR_SENSITIVE_TOOLS, ...Object.keys(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT)].filter((name) => !tools.has(name));
    expect(missing).toEqual([]);
  });

  it('every argument a rule reads exists in that tool\'s input schema', () => {
    const problems: string[] = [];
    for (const [name, rule] of Object.entries(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT)) {
      const props = schemaOf(tools.get(name))?.properties ?? {};
      const wanted = rule.kind === 'action' ? [rule.argument] : [...rule.arguments];
      for (const arg of wanted) if (!(arg in props)) problems.push(`${name}.${arg}`);
    }
    expect(problems).toEqual([]);
  });

  it('every action a tool\'s schema declares is classified the way this list says (a new action must be looked at)', () => {
    const expectedWrites: Record<string, string[]> = {
      email: ['send'],
      linkedin_manage_post: ['repost', 'comment', 'react', 'delete_post'],
      manage_scheduled_chat: ['delete'],
      call_attio_api: ['ADD_ENTRIES', 'REMOVE_ENTRIES', 'CREATE'],
    };
    const problems: string[] = [];
    for (const [name, rule] of Object.entries(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT)) {
      if (rule.kind !== 'action') continue;
      const values: unknown = schemaOf(tools.get(name))?.properties?.[rule.argument]?.enum;
      if (!Array.isArray(values)) continue; // a free-text action (Google Ads, HubSpot, LinkedIn, X): unknown values are sensitive by rule
      for (const value of values) {
        const sensitive = isSensitiveToolCall(name, { [rule.argument]: value });
        const isWrite = (expectedWrites[name] ?? []).includes(String(value));
        if (name in expectedWrites && sensitive !== isWrite) problems.push(`${name}.${rule.argument}=${value} is ${sensitive ? 'sensitive' : 'allowed'}`);
        if (!(name in expectedWrites) && /^(send|reply|post|delete|follow|block|mute|like|retweet|repost|quote|react|comment|create|update|remove|add|publish)/i.test(String(value)) && !sensitive) {
          problems.push(`${name}.${rule.argument}=${value} looks like a write but is allowed`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('a tool whose name looks outward facing is classified: sensitive, sensitive by argument, or reviewed and written down here', () => {
    const unclassified = [...tools.keys()]
      .filter((name) => OUTWARD_NAME.test(name))
      .filter((name) => !SHARE_VISITOR_SENSITIVE_TOOLS.has(name) && !(name in SHARE_VISITOR_SENSITIVE_BY_ARGUMENT))
      .filter((name) => !(name in REVIEWED_NOT_SENSITIVE))
      .filter((name) => !SHARE_VISITOR_BLOCKED_TOOLS.has(name) && !ADMIN_SKILL_TOOL_NAMES.includes(name))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('the reviewed-not-sensitive list has no stale names and no name that is also in the sensitive list', () => {
    const stale = Object.keys(REVIEWED_NOT_SENSITIVE).filter((name) => !tools.has(name));
    const both = Object.keys(REVIEWED_NOT_SENSITIVE).filter((name) => SHARE_VISITOR_SENSITIVE_TOOLS.has(name) || name in SHARE_VISITOR_SENSITIVE_BY_ARGUMENT);
    expect({ stale, both }).toEqual({ stale: [], both: [] });
  });
});
