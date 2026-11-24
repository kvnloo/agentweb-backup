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
  sensitiveActionUnverifiableRefusal, SHARE_VISITOR_SENSITIVE_RUNTIME_TOOLS, SHARE_VISITOR_SCHEDULE_ONLY_SENSITIVE_BY_ARGUMENT, isSensitiveInVisitorScheduleCall } from '../services/toolRestrictionProfiles';
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
      'clear_browser_cookies', 'load_browser_cookies', 'mark_browser_session_failed', 'read_verification_code', 'save_browser_cookies',
      'notify_session', 'post_on_connected_account', 'publish_blog_article', 'publish_landing_page_changes',
      'regenerate_market_strategy', 'revert_landing_page_publish', 'revoke_linkedin_account',
      'send_email_from_sender', 'send_email_to_lead', 'send_gtm_status_report', 'set_landing_page_lead_list', 'slack_send_message',
      'test_scheduled_chat',
      // ENG-3170 final review: the old agent-engine task tools (they read the owner's saved logins in a real browser), the decision a team
      // approver settles (it resumes the session as a full owner turn), and what the owner set up inside the account
      'create_revision', 'create_task_from_prompt', 'create_task_from_template', 'stage_pending_decision',
      'configure_lead_statuses', 'save_test_account', 'update_brand_guidelines', 'update_knowledge_base_file', 'update_lead_list', 'update_market_strategy',
      // the exhaustive pass over every registered tool (2026-11-24)
      'create_image_task_from_prompt', 'generate_landing_page', 'duplicate_landing_page', 'create_skill', 'save_work_plan',
      'attach_knowledge_base_files', 'create_knowledge_base', 'create_html_template', 'create_book_outline', 'update_google_doc', 'update_google_sheet',
      'report_product_issues', 'write_clickup_doc', 'create_clickup_task', 'coding_agent', 'list_test_accounts', 'open_site_signin',
      // the third review round: the mailbox is where a login code or reset link would be read from
      'email',
    ].sort());

    expect([...SHARE_VISITOR_SENSITIVE_RUNTIME_TOOLS].sort()).toEqual([
      'add_issue_comment', 'create_branch', 'create_issue', 'create_or_update_file', 'create_pull_request', 'create_pull_request_review', 'create_repository',
      'delete_file', 'fork_repository', 'merge_pull_request', 'push_files', 'update_issue', 'update_pull_request_branch',
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
      ['linkedin_outreach', ['search-people', 'get-profile', 'list-connections', 'list-sent-invitations', 'list-received-invitations', 'get-company', 'search-parameters', 'list-post-engagers'], ['send-invite', 'send-message', 'send-inmail', 'accept-invitation', 'cancel-invitation', 'withdraw-stale-invitations', 'set-daily-invite-cap', 'update-conversation-history']],
      ['linkedin_manage_post', ['list_comments', 'get_analytics'], ['repost', 'comment', 'react', 'delete_post']],
      ['twitter_manage_post', ['get_tweet_metrics', 'list_replies', 'get_retweeters', 'get_liking_users', 'get_quote_tweets'], ['reply', 'post_thread', 'quote_tweet', 'delete_tweet', 'like', 'unlike', 'retweet', 'unretweet']],
      ['twitter_outreach', ['get_profile', 'list_followers', 'list_following', 'search_tweets', 'get_user_tweets', 'list_dms', 'get_dm_conversation', 'get_bookmarks', 'get_liked_tweets', 'list_owned_lists', 'get_list_members', 'get_list_tweets'], ['send_dm', 'follow', 'unfollow', 'block', 'unblock', 'mute', 'unmute', 'bookmark']],
      ['call_google_ads_api', ['LIST', 'SEARCH'], ['CREATE', 'UPDATE', 'REMOVE', 'PAUSE', 'RESUME', 'ADD', 'ADD_NEGATIVE', 'ATTACH', 'UPLOAD', 'RETAG_UTM', 'ADD_PROXIMITY', 'REMOVE_PROXIMITY', 'SET_DEVICE_BID_ADJUSTMENT']],
      ['call_hubspot_api', ['LIST', 'GET', 'SEARCH', 'GET_STATS', 'GET_METRICS', 'GET_PERFORMANCE', 'GET_CONTACTS', 'GET_FORM_FIELDS', 'GET_SUBMISSIONS', 'LIST_ASSETS', 'LIST_BROADCASTS', 'LIST_CHANNELS', 'LIST_PIPELINES', 'LIST_SUBSCRIPTION_TYPES'], ['CREATE', 'UPDATE', 'DELETE', 'CLONE', 'PUBLISH', 'UNPUBLISH', 'ADD_ASSET', 'REMOVE_ASSET', 'ADD_CONTACTS', 'REMOVE_CONTACTS', 'ENABLE', 'DISABLE', 'SUBMIT', 'CREATE_BROADCAST', 'DELETE_BROADCAST']],
      ['call_attio_api', ['SEARCH', 'COUNT', 'LIST', 'GET'], ['ADD_ENTRIES', 'REMOVE_ENTRIES', 'CREATE']],
      ['call_linkedin_marketing_api', ['LIST', 'GET', 'LIST_FACETS', 'SEARCH', 'ESTIMATE_REACH'], ['CREATE', 'CREATE_INLINE', 'CREATE_DYNAMIC', 'UPDATE', 'RETAG_UTM', 'SEND_TEST', 'CREATE_CONTENT', 'SET_FIRST_CONTENT', 'INIT_IMAGE_UPLOAD', 'INIT_VIDEO_UPLOAD', 'UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'UPLOAD_DOCUMENT', 'FINALIZE_VIDEO']],
      // a toggle is judged with its status (see the next describe): on its own it reads as sensitive
      ['manage_scheduled_chat', ['create', 'update'], ['delete', 'toggle']],
      // read is free, any update replaces the owner's business overview and merges competitors and ICPs
      ['manage_market_strategy', ['read', ' Read '], ['update', 'replace', 'delete']],
      // setting do-not-contact or unsubscribed only restricts outreach; 'active' clears the flag and allows contact again
      ['set_lead_contact_status', ['do-not-contact', 'unsubscribed'], ['active']],
    ];

    it.each(mixed)('%s: its reads are allowed and its writes are sensitive', (tool, reads, writes) => {
      const argument = tool === 'set_lead_contact_status' ? 'contact_status' : 'action';
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

  describe('a schedule toggle may PAUSE but not RESUME (ENG-3170 final review)', () => {
    // A toggle writes no visitor mark, so resuming one of the owner's paused schedules would let it run again, unrestricted, as the owner.
    const toggle = (status: unknown) => isSensitiveToolCall('manage_scheduled_chat', { action: 'toggle', schedule_id: 's1', status });
    it('pausing is allowed, in any case or spacing', () => {
      for (const status of ['paused', 'PAUSED', ' Paused ']) expect({ status, sensitive: toggle(status) }).toEqual({ status, sensitive: false });
    });
    it('resuming, an unknown, a missing or a non-text status is sensitive (fail closed)', () => {
      for (const status of ['active', 'ACTIVE', 'resumed', '', '   ', undefined, null, 1, true, ['paused'], { x: 'paused' }]) {
        expect({ status, sensitive: toggle(status) }).toEqual({ status, sensitive: true });
      }
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: 'toggle' })).toBe(true);
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: 'toggle', status: 'paused', schedule_id: 's1' })).toBe(false);
    });
    it('create and update keep their own rule (provenance), and a status on them changes nothing', () => {
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: 'create', status: 'active' })).toBe(false);
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: 'update', status: 'active' })).toBe(false);
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: 'delete', status: 'paused' })).toBe(true);
    });
    it('an action named like an Object.prototype key does not read as an extra requirement', () => {
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: 'constructor', status: 'paused' })).toBe(true);
      expect(isSensitiveToolCall('manage_scheduled_chat', { action: '__proto__', status: 'paused' })).toBe(true);
    });
  });

  describe('a schedule create or update may not name recipients or re-time/re-model a schedule (exhaustive pass, 2026-11-24)', () => {
    // timing and the model are not tracked by the schedule provenance on purpose, and the recipients of a run's emailed result are not restricted by the
    // visitor mark (it restricts the tools a run may use), so on the owner's own schedule these would make it run now / far more often / mail an outside address
    const call = (action: string, extra: Record<string, unknown>) => isSensitiveToolCall('manage_scheduled_chat', { action, schedule_id: 's1', ...extra });
    it('an update that carries only provenance-tracked content is allowed', () => {
      expect(call('update', { starting_message: 'new prompt' })).toBe(false);
      expect(call('update', { schedule_name: 'n', description: 'd', keywords: ['k'], self_improve: true, email_notifications: [] })).toBe(false);
    });
    it.each(['schedule_frequency', 'frequency_interval_days', 'next_run_time', 'timezone', 'run_count', 'llm_model', 'backup_model', 'daily_digest'])(
      'an update that sets %s is sensitive', (field) => {
        expect(call('update', { [field]: field === 'run_count' ? -1 : field === 'daily_digest' ? true : 'x' })).toBe(true);
        expect(call('update', { [field]: field === 'run_count' ? -1 : field === 'daily_digest' ? true : 'x', starting_message: 'p' })).toBe(true);
      });
    it('naming recipients is sensitive on create and on update, clearing them is not', () => {
      expect(call('create', { email_notifications: ['someone@example.com'] })).toBe(true);
      expect(call('update', { email_notifications: ['someone@example.com'] })).toBe(true);
      expect(call('create', { email_notifications: [] })).toBe(false);
      expect(call('create', { schedule_name: 'n', starting_message: 'm', schedule_frequency: 'daily' })).toBe(false);
    });
  });

  describe('email is sensitive whatever its action: search and get read login codes and magic links out of the owner\'s mailbox', () => {
    it.each(['search', 'list', 'get', 'send', '', undefined])('action %p', (action) => {
      expect(isSensitiveToolCall('email', { action })).toBe(true);
    });
    it('and with no arguments at all', () => { expect(isSensitiveToolCall('email', undefined)).toBe(true); expect(isSensitiveToolCall('email', {})).toBe(true); });
  });

  describe('the tools that exist only at runtime (the per-user GitHub MCP server)', () => {
    it('their write tools are sensitive by name, whatever the arguments; their reads are not listed', () => {
      for (const tool of SHARE_VISITOR_SENSITIVE_RUNTIME_TOOLS) for (const args of [undefined, {}, { owner: 'o', repo: 'r' }]) expect(isSensitiveToolCall(tool, args)).toBe(true);
      for (const read of ['get_file_contents', 'search_repositories', 'list_commits', 'get_issue', 'search_code', 'list_pull_requests']) expect(isSensitiveToolCall(read, {})).toBe(false);
    });
  });

  describe('Meta writes are sensitive only in a run of a schedule a visitor wrote (an unattended run stages them for an approver who is not the owner)', () => {
    const meta = (action: unknown) => isSensitiveInVisitorScheduleCall('call_meta_marketing_api', { entity_type: 'CAMPAIGN', action });
    it.each(['LIST', 'GET', 'SEARCH', 'PREVIEW', 'GET_MATCH_QUALITY', 'get_insights', ' list '])('the read action %p is allowed', (action) => expect(meta(action)).toBe(false));
    it.each(['CREATE', 'UPDATE', 'PAUSE', 'RESUME', 'DELETE', 'ARCHIVE', 'COPY', 'RETAG_UTM', 'UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'brand-new-action', '', undefined, 7, ['LIST']])('%p is sensitive (fail closed)', (action) => expect(meta(action)).toBe(true));
    it('a missing argument object is sensitive, and no other tool is judged', () => {
      expect(isSensitiveInVisitorScheduleCall('call_meta_marketing_api', undefined)).toBe(true);
      expect(isSensitiveInVisitorScheduleCall('get_leads', { action: 'CREATE' })).toBe(false);
      expect(isSensitiveInVisitorScheduleCall('constructor', {})).toBe(false);
    });
    it('it is NOT sensitive in a visitor\'s own chat (the rule that judges those calls does not know it)', () => {
      expect(isSensitiveToolCall('call_meta_marketing_api', { entity_type: 'CAMPAIGN', action: 'CREATE' })).toBe(false);
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
      // the exhaustive pass (2026-11-24): a recipient a visitor names, a run-now flag, an unattended plan
      ['update_gtm_work_item', 'dri', 'someone@example.com', ''],
      ['update_gtm_plan', 'dri', 'someone@example.com', ''],
      ['update_gtm_phase', 'dri', 'someone@example.com', ''],
      ['add_gtm_phase', 'dri', 'someone@example.com', ''],
      ['create_gtm_plan', 'dri', 'someone@example.com', ''],
      ['create_schedule_from_template', 'email_notifications', ['someone@example.com'], []],
      ['submit_scheduled_chat_variables', 'trigger_run', true, false],
      ['create_work_plan', 'autocomplete', true, false],
      ['modify_work_plan', 'autocomplete', true, false],
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
    for (const tool of ['read_brand_guidelines', 'list_leads', 'call_google_ads_api', 'call_hubspot_api', 'google_calendar_create_event', 'unknown_tool', 'constructor']) {
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
  call_meta_marketing_api: 'in a visitor\'s own chat every write halts into an approval deck that only the owner can answer (the share route answers 403 otherwise); in a run of a schedule a visitor wrote it is refused (SHARE_VISITOR_SCHEDULE_ONLY_SENSITIVE_BY_ARGUMENT)',
  manage_schedule_template: 'visitor writes are refused (ENG-2816)',
  // internal: nothing leaves the account, or nothing is lost
  find_or_lookup_email: 'a lookup',
  update_email_draft_for_lead: 'overwrites a lead\'s email DRAFT inside the account (no history); sending it is send_email_to_lead, which is sensitive',
  get_temp_email: 'a throwaway inbox for sign-ups',
  create_social_media_posts: 'builds an HTML file of posts; nothing is posted',
  get_deployment_status: 'a status read that updates a status field',
  get_leads_needing_followup: 'a read',
  create_lead_list: 'adds data inside the account',
  add_leads_to_list: 'adds leads inside the account; a merge overwrites an existing lead\'s fields (same kind of edit as update_lead)',
  remove_image_background: 'image editing',
  remove_c2pa_from_image: 'image editing',
  send_for_review: 'the result-link review flow: the recipient comes from the session\'s own configuration (the visitor does not choose it), and a result-link flow for an outside recipient relies on it',
  list_connected_account_posts: 'a read',
  list_connected_accounts: 'a read',
  launch_predefined_work_plan: 'writes the session\'s own work plan',
  enqueue_human_eval: 'AgentWeb\'s own review queue: the visitor\'s text and the owner\'s email go to AgentWeb\'s internal Slack channel, not to the owner\'s contacts (generate_image posts the same way)',
  fathom_route_action_items: 'a stub that creates nothing today (services/meetingIntakeService.ts); it writes to AgentWeb\'s own boards, so it becomes sensitive if it is ever wired up',
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
  // ENG-3170 review: found by widening the name pattern to the neutral verbs. Nothing here sends or posts anything; each edits data inside the account.
  // (The tools that overwrite what the owner set up inside the account, brand guidelines, market strategy, knowledge base, status stages, list settings and a saved test
  // login, are NOT here any more: the approved wording says an OFF link cannot "change your settings or Emma's memory", so they are on the sensitive list.)
  update_lead: 'edits a lead\'s fields inside the account, blanking included (judgement call, owner\'s to make); it can not set the do-not-contact flag, which is set_lead_contact_status',
  update_lead_status: 'records a lead\'s pipeline status and the draft on the lead; sends nothing',
  update_book_content: 'find-and-replace edits to a book inside the account, no history (judgement call, owner\'s to make)',
  update_landing_page_context: 'overwrites the owner\'s note about a landing page inside the account (judgement call, owner\'s to make)',
  update_html_file: 'edits a file in the session\'s own workspace',
  save_file: 'writes a file in the session\'s own workspace',
  // The exhaustive pass over every registered tool (2026-11-24). Mutating, and judged NOT to break the promise (each verified in the code):
  add_gtm_common_items: 'database writes only, no notification (a `dri` set inside items is a known limit: the update tools and the work-item tool carry the rule)',
  add_gtm_work_items: 'database write only, no notification (see add_gtm_common_items)',
  add_lead_engagement: 'writes one custom.* event on a lead',
  assign_lead: 'a label on the lead; the previous value is logged; it grants no access',
  compose_video: 'output is saved to AgentWeb storage and returned to the chat',
  convert_to_pdf: 'output is saved to AgentWeb storage and returned to the chat',
  create_html_file: 'a new file in the session\'s own workspace',
  create_html_from_template: 'a new file in the session\'s own workspace, from an existing template',
  create_book: 'a new private record inside the account',
  generate_book_content: 'rewrites one chapter of a book, using the existing text (same kind of edit as update_book_content)',
  generate_image: 'output is saved and returned to the chat (it also posts to AgentWeb\'s internal eval channel, like enqueue_human_eval)',
  generate_video: 'output is saved and returned to the chat',
  generate_voiceover: 'output is saved and returned to the chat',
  mux_video_with_audio: 'a new file in AgentWeb storage, nothing published',
  materialize_knowledge_base_asset: 'a new file in AgentWeb storage, nothing published',
  repair_blog_article: 'a new file in AgentWeb storage, nothing published',
  enrich_lead_custom: 'enrichment into the lead; with overwrite_policy always_overwrite it replaces existing values (judgement call, owner\'s to make; preview writes nothing)',
  enrich_leads_execute: 'enrichment into the leads; with overwrite_policy always_overwrite it replaces existing values (judgement call, owner\'s to make; preview writes nothing)',
  import_leads_from_search: 'adds leads inside the account (the import notification is off by default); searches with the owner\'s own LinkedIn account',
  install_skills: 'adds skills to THIS session only; the subscription checks still apply',
  log_contact_event: 'adds one entry to a contact\'s timeline, duplicates removed',
  present_question_deck: 'puts a question deck in this session; the visitor answers it',
  promote_to_deal: 'an internal deal record',
  rotate_primary: 'an internal deal record, reversible',
  recommend_predefined_work_plan: 'a proposal card in this session only',
  set_work_plan_status: 'changes this session\'s own plan status; the plan\'s tool calls are still checked one by one',
  solve_captcha: 'spends the owner\'s captcha credits; the browser steps it makes inherit the visitor\'s limits',
  ask_user_question: 'writes a question card to the session only',
  read_market_strategy: 'a read (the name contains "mark")',
  load_connected_account_metrics: 'a read of a connected account\'s metrics',
  google_drive: 'creates folders in the owner\'s own drive',
};

// Tools that do not change anything (judged in the 2026-11-24 per-tool pass by reading the implementation) and whose names do not say so.
const REVIEWED_READ_ONLY: Record<string, string> = {
  account_summary: 'a read', ask_crm: 'a question answered from the CRM', audit_ad_utm_coverage: 'an audit, a read',
  enrich_leads_preview: 'a preview, writes nothing', fathom_get_meetings: 'a read', fathom_get_onboarding_context: 'a read', fathom_get_transcript: 'a read',
  google_calendar_get_event: 'a read', google_calendar_list_calendars: 'a read', google_calendar_list_events: 'a read',
  google_search_web: 'a web search', you_search_news: 'a web search', you_search_web: 'a web search',
  jev_decide: 'a decision returned to the model', navigate_to: 'a no-op that tells the UI where to go',
  perform_data_analysis: 'an analysis in a sandbox, returned to the chat', perform_deep_research: 'research returned to the chat',
  request_user_captcha_solution: 'asks the person in the chat', resolve_skill: 'a lookup', run_local_agent_task: 'a retired stub that always fails',
  scan_website_links: 'a read of a public site', wait_seconds: 'a pause',
};

// A tool whose name starts like this is a read (a name pattern; a new tool named like a read but doing more is the one thing this test cannot catch).
const READ_NAME = /^(get|list|read|search|find|check|lookup|fetch|query|view|inspect|analy[sz]e|describe|count|summari[sz]e|preview|explain|validate|detect|estimate|compare|calculate)_/;

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

  it('the runtime (GitHub MCP) tool names never shadow a tool of ours, and the schedule-only Meta rule names a tool and an argument that exist', () => {
    expect([...SHARE_VISITOR_SENSITIVE_RUNTIME_TOOLS].filter((name) => tools.has(name))).toEqual([]);
    const props = schemaOf(tools.get('call_meta_marketing_api'))?.properties ?? {};
    for (const [name, rule] of Object.entries(SHARE_VISITOR_SCHEDULE_ONLY_SENSITIVE_BY_ARGUMENT)) {
      expect(tools.has(name)).toBe(true);
      if (rule.kind === 'action') expect(Object.keys(props)).toContain(rule.argument);
    }
  });

  it('every argument a rule reads exists in that tool\'s input schema', () => {
    const problems: string[] = [];
    for (const [name, rule] of Object.entries(SHARE_VISITOR_SENSITIVE_BY_ARGUMENT)) {
      const props = schemaOf(tools.get(name))?.properties ?? {};
      const wanted = rule.kind === 'action'
        ? [rule.argument, ...Object.values(rule.alsoRequire ?? {}).map((extra) => extra.argument), ...Object.values(rule.forbidWhenSet ?? {}).flat()]
        : [...rule.arguments];
      for (const arg of wanted) if (!(arg in props)) problems.push(`${name}.${arg}`);
    }
    expect(problems).toEqual([]);
  });

  it('the status a toggle is allowed with is a value the tool really accepts, and "active" is another one (the one that is refused)', () => {
    const status = schemaOf(tools.get('manage_scheduled_chat'))?.properties?.status?.enum;
    expect(status).toEqual(expect.arrayContaining(['paused', 'active']));
  });

  it('every action a tool\'s schema declares is classified the way this list says (a new action must be looked at)', () => {
    const expectedWrites: Record<string, string[]> = {
      email: ['send'],
      linkedin_manage_post: ['repost', 'comment', 'react', 'delete_post'],
      manage_scheduled_chat: ['delete', 'toggle'], // a toggle is allowed only to pause, so on its own (no status) it counts as sensitive
      manage_market_strategy: ['update'],
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

  it('CLOSED WORLD: every registered tool is classified: sensitive, sensitive by argument, blocked, admin, reviewed with a reason, or named like a read', () => {
    const unclassified = [...tools.keys()]
      .filter((name) => name !== 'connect_account') // refused for a visitor by its own rule
      .filter((name) => !SHARE_VISITOR_SENSITIVE_TOOLS.has(name) && !(name in SHARE_VISITOR_SENSITIVE_BY_ARGUMENT))
      .filter((name) => !SHARE_VISITOR_BLOCKED_TOOLS.has(name) && !ADMIN_SKILL_TOOL_NAMES.includes(name))
      .filter((name) => !(name in REVIEWED_NOT_SENSITIVE) && !(name in REVIEWED_READ_ONLY))
      .filter((name) => !READ_NAME.test(name))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('the read-only list has no stale names and no name that is also classified elsewhere', () => {
    const stale = Object.keys(REVIEWED_READ_ONLY).filter((name) => !tools.has(name));
    const both = Object.keys(REVIEWED_READ_ONLY).filter((name) => SHARE_VISITOR_SENSITIVE_TOOLS.has(name) || name in SHARE_VISITOR_SENSITIVE_BY_ARGUMENT || name in REVIEWED_NOT_SENSITIVE);
    expect({ stale, both }).toEqual({ stale: [], both: [] });
  });

  it('the reviewed-not-sensitive list has no stale names and no name that is also in the sensitive list', () => {
    const stale = Object.keys(REVIEWED_NOT_SENSITIVE).filter((name) => !tools.has(name));
    const both = Object.keys(REVIEWED_NOT_SENSITIVE).filter((name) => SHARE_VISITOR_SENSITIVE_TOOLS.has(name) || name in SHARE_VISITOR_SENSITIVE_BY_ARGUMENT);
    expect({ stale, both }).toEqual({ stale: [], both: [] });
  });
});
