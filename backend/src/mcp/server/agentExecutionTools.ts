/**
 * ENG-2948 (ENG-2847.9) — single source of truth for main-MCP tools that
 * execute, resume, or delegate to the Emma agent.
 *
 * Purpose: an external deterministic caller (Yugo acting on customer accounts
 * via AW keys) must be able to build an allowlist that excludes every tool
 * capable of starting or resuming an agent run. The `emma_` prefix is NOT a
 * reliable signal — e.g. `emma_get_brand_profile` is deterministic — so the
 * classification is an explicit list.
 *
 * Additive only: nothing in the server enforces this list yet. Enforcement on
 * keys is a scope/security-posture decision tracked under ENG-2910.
 */

export const AGENT_EXECUTION_TOOLS: readonly string[] = Object.freeze([
  // Delegation entry point: creates the session agent runs attach to.
  'emma_create_session',
  // Execute or resume the agent.
  'emma_send_message',
  'emma_answer_question_deck',
  'emma_launch_work_plan',
  'emma_answer_work_plan_input',
  'execute_task',
  'test_scheduled_chat',
  'emma_run_marketing_task',
  // Executes the agent when an immediate run is requested; classified
  // conservatively as execution for allowlist purposes.
  'submit_scheduled_chat_variables',
]);

/**
 * ENG-2969 (ENG-2847.15) — reviewed classification of every other main-MCP
 * tool: these do not start, resume, or delegate to an Emma agent run in the
 * request itself. Every tool registered with the main MCP registry must appear
 * in exactly one of AGENT_EXECUTION_TOOLS or DETERMINISTIC_TOOLS; the drift
 * guard in __tests__/agentExecutionTools.test.ts fails on a new unclassified
 * registration. Before adding a new tool here, confirm its handler cannot run
 * the agent; if it can, add it to AGENT_EXECUTION_TOOLS instead.
 *
 * Note: schedule-creating tools (manage_schedule, manage_scheduled_chat,
 * create_schedule_from_template, emma_schedule_recurring_work) only persist a
 * future run and are listed here; whether keys may create deferred agent runs
 * is the scope decision tracked under ENG-2910.
 */
export const DETERMINISTIC_TOOLS: readonly string[] = Object.freeze([
  // Smartlead MCP reads/stop controls never start or resume an Emma agent run.
  'list_smartlead_campaigns',
  'get_smartlead_campaign_stats',
  'preview_smartlead_push',
  'get_smartlead_push_status',
  'pause_smartlead_push',
  'cancel_smartlead_push',
  'assess_client_health',
  'check_account_tracking_health',
  'read_client_meta_activity',
  'read_client_meta_budgets',
  'configure_landing_page_subdomain',
  'create_blog_article',
  'create_knowledge_base_file',
  'create_lead_list',
  'create_schedule_from_template',
  'delete_knowledge_base_file',
  'delete_landing_page',
  'delete_memory',
  'delete_org_memory',
  'deploy_landing_page',
  'diagnose_leads_at_zero',
  'duplicate_landing_page',
  'edit_landing_page_file',
  'emma_create_gtm_plan',
  'emma_create_landing_page',
  'emma_edit_landing_page',
  'emma_find_leads',
  'emma_get_account_status',
  'emma_get_brand_profile',
  'emma_get_session',
  'emma_list_models',
  'emma_list_sessions',
  'emma_publish_blog_post',
  'emma_publish_social_post',
  'emma_research',
  'emma_review_site',
  'emma_schedule_recurring_work',
  'emma_search_tools',
  'enable_lead_list_public_access',
  'enable_session_tracking',
  'evaluation_workspace',
  'export_lead_list',
  'freeze_user_account',
  'generate_image',
  'generate_landing_page',
  'get_account_status',
  // Account reads (accountReadTools.ts): the caller's own social accounts, ads thresholds, profile, org settings, the public docs.
  'get_ads_thresholds',
  'get_chat_history',
  'get_conversion_summary',
  'get_deployment_status',
  'get_hot_lead_call_settings',
  'get_landing_page',
  'get_landing_page_effective_view',
  'get_landing_page_preview_url',
  'get_landing_page_subdomain',
  // Lead reads (leadReadTools.ts): a lead's details, its engagement history, a list's pipeline stages. Deterministic CRM reads.
  'get_lead_details',
  'get_lead_engagements',
  'get_lead_list_statuses',
  'get_lead_notification_settings',
  'get_post_analytics',
  'get_pr_digest',
  'get_registration_status',
  'get_scheduled_chat_storage_diagnostics',
  'get_scheduled_chat_test_history',
  'get_session_transcript',
  'get_user_by_id',
  'get_user_profile',
  'get_users_by_lifecycle_stage',
  'google_search_web',
  'inspect_client_usage',
  'inspect_orphaned_org_join_requests',
  'install_skills',
  'iterate_landing_page',
  'list_all_clients',
  'list_available_skills',
  'list_connected_account_posts',
  'list_connected_accounts',
  'list_crm_sequences',
  'list_gtm_plans',
  'list_knowledge_bases',
  'list_landing_page_files',
  'list_landing_pages',
  'list_lead_list_exports',
  'list_lead_lists',
  'list_memories',
  'list_predefined_work_plans',
  'list_schedule_templates',
  'list_scheduled_chats',
  'list_schedules',
  'list_sender_settings',
  'list_skills',
  'list_task_executions',
  'list_tasks',
  'load_connected_account_metrics',
  'manage_brand',
  'manage_crm_sequence',
  'manage_gtm_items',
  'manage_gtm_plan',
  'manage_leads',
  'manage_market_strategy',
  'manage_predefined_work_plan',
  'manage_schedule',
  'manage_schedule_template',
  'manage_scheduled_chat',
  'manage_scoring_judges',
  'manage_skill',
  'manage_task',
  'manage_user_notes',
  'monitor_lead_volume',
  'post_on_account',
  'publish_blog_article',
  'publish_landing_page_changes',
  'read_email',
  'read_knowledge_base_files',
  'read_landing_page_file',
  'resolve_landing_page_by_url',
  'resolve_skill',
  'revert_landing_page_publish',
  'save_file',
  'save_memory',
  'save_org_memory',
  'search_knowledge_base',
  'search_leads',
  'search_user_guide',
  'send_email',
  // Emails a GTM status report: a deterministic report builder behind the opt-in gtm:email key scope (gtmEmailTool.ts); it never runs the agent.
  'send_gtm_status_report',
  'set_landing_page_lead_list',
  'share_landing_page_with_org',
  'update_knowledge_base_file_content',
  'update_landing_page_context',
  'update_landing_page_files',
  'update_sender_settings',
  'you_search_news',
  'you_search_web',
]);

const AGENT_EXECUTION_TOOL_SET: ReadonlySet<string> = new Set(AGENT_EXECUTION_TOOLS);

/** True when the tool can execute, resume, or delegate to the Emma agent. */
export function isAgentExecutionTool(name: string): boolean {
  return AGENT_EXECUTION_TOOL_SET.has(name);
}

/** Returns the input tool names minus every agent-execution tool, order preserved. */
export function filterDeterministicTools(names: readonly string[]): string[] {
  return names.filter((name) => !isAgentExecutionTool(name));
}
