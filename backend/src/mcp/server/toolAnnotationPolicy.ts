/**
 * ENG-2334 (ENG-336.2) — the typed MCP tool annotation policy.
 *
 * Every tool on the PUBLIC MCP surface (tools/list plus the
 * emma_search_tools-discoverable catalogue) must be classified here. An
 * unclassified public tool fails the CI gate in
 * __tests__/mcp.publicToolInventory.test.ts — it is never silently annotated.
 *
 * 'read'  — no possible call writes anything (mirrors McpToolHandler.readOnly).
 * 'write' — any call MAY mutate state, send, publish, or persist. Tools that
 *           write only under some arguments are 'write' (e.g. get_chat_history:
 *           sync=true persists satisfaction scores).
 *
 * Classification only — this module changes no description copy.
 */
export type McpToolSideEffect = 'read' | 'write';

export const MCP_TOOL_SIDE_EFFECTS: Readonly<Record<string, McpToolSideEffect>> = Object.freeze({
  assess_client_health: 'write',
  cancel_smartlead_push: 'write',
  check_account_tracking_health: 'write',
  configure_landing_page_subdomain: 'write',
  create_knowledge_base_file: 'write',
  create_lead_list: 'write',
  create_schedule_from_template: 'write',
  delete_knowledge_base_file: 'write',
  delete_landing_page: 'write',
  deploy_landing_page: 'write',
  diagnose_leads_at_zero: 'write',
  duplicate_landing_page: 'write',
  edit_landing_page_file: 'write',
  emma_answer_question_deck: 'write',
  emma_answer_work_plan_input: 'write',
  emma_create_gtm_plan: 'write',
  emma_create_landing_page: 'write',
  emma_create_session: 'write',
  emma_edit_landing_page: 'write',
  emma_find_leads: 'write',
  emma_get_account_status: 'write',
  emma_get_brand_profile: 'write',
  emma_get_session: 'write',
  emma_launch_work_plan: 'write',
  emma_list_models: 'write',
  emma_list_sessions: 'write',
  emma_publish_blog_post: 'write',
  emma_publish_social_post: 'write',
  emma_research: 'write',
  emma_review_site: 'read',
  emma_run_marketing_task: 'write',
  emma_schedule_recurring_work: 'write',
  emma_search_tools: 'read',
  emma_send_message: 'write',
  enable_lead_list_public_access: 'write',
  enable_session_tracking: 'write',
  evaluation_workspace: 'write',
  execute_task: 'write',
  freeze_user_account: 'write',
  generate_image: 'write',
  generate_landing_page: 'write',
  get_account_status: 'write',
  get_chat_history: 'write',
  get_deployment_status: 'write',
  get_landing_page: 'write',
  get_landing_page_effective_view: 'write',
  get_landing_page_preview_url: 'write',
  get_landing_page_subdomain: 'write',
  get_pr_digest: 'write',
  get_registration_status: 'write',
  get_scheduled_chat_storage_diagnostics: 'write',
  get_scheduled_chat_test_history: 'write',
  get_session_transcript: 'write',
  get_smartlead_campaign_stats: 'read',
  get_smartlead_push_status: 'read',
  get_user_by_id: 'write',
  get_users_by_lifecycle_stage: 'write',
  inspect_orphaned_org_join_requests: 'write',
  iterate_landing_page: 'write',
  list_all_clients: 'write',
  list_connected_accounts: 'write',
  list_crm_sequences: 'write',
  list_gtm_plans: 'write',
  list_knowledge_bases: 'write',
  list_landing_page_files: 'write',
  list_landing_pages: 'write',
  list_lead_lists: 'read',
  list_predefined_work_plans: 'write',
  list_schedule_templates: 'write',
  list_scheduled_chats: 'write',
  list_schedules: 'write',
  list_sender_settings: 'read',
  get_conversion_summary: 'read',
  list_skills: 'write',
  list_smartlead_campaigns: 'read',
  list_task_executions: 'write',
  list_tasks: 'write',
  manage_brand: 'write',
  manage_crm_sequence: 'write',
  manage_gtm_items: 'write',
  manage_gtm_plan: 'write',
  manage_leads: 'write',
  manage_market_strategy: 'write',
  manage_predefined_work_plan: 'write',
  manage_schedule: 'write',
  manage_schedule_template: 'write',
  manage_scheduled_chat: 'write',
  manage_scoring_judges: 'write',
  manage_skill: 'write',
  manage_task: 'write',
  manage_user_notes: 'write',
  monitor_lead_volume: 'write',
  pause_smartlead_push: 'write',
  preview_smartlead_push: 'read',
  publish_landing_page_changes: 'write',
  read_email: 'read',
  read_knowledge_base_files: 'write',
  read_landing_page_file: 'write',
  resolve_landing_page_by_url: 'write',
  resolve_skill: 'write',
  revert_landing_page_publish: 'write',
  search_knowledge_base: 'write',
  search_leads: 'write',
  set_landing_page_lead_list: 'write',
  share_landing_page_with_org: 'write',
  submit_scheduled_chat_variables: 'write',
  test_scheduled_chat: 'write',
  update_knowledge_base_file_content: 'write',
  update_landing_page_context: 'write',
  update_sender_settings: 'write',
  list_lead_list_exports: 'read',
  inspect_client_usage: 'write',
  export_lead_list: 'write',
  update_landing_page_files: 'write',
});

export class UnclassifiedMcpToolError extends Error {
  constructor(name: string) {
    super(`MCP tool "${name}" has no annotation policy entry (ENG-2334). Classify it in toolAnnotationPolicy.ts.`);
    this.name = 'UnclassifiedMcpToolError';
  }
}

/** Fail closed: an unclassified tool throws rather than defaulting. */
export function classifyMcpTool(name: string): McpToolSideEffect {
  const c = Object.prototype.hasOwnProperty.call(MCP_TOOL_SIDE_EFFECTS, name)
    ? MCP_TOOL_SIDE_EFFECTS[name]
    : undefined;
  if (c !== 'read' && c !== 'write') throw new UnclassifiedMcpToolError(name);
  return c;
}

/** Schema property names that must never appear on a public tool. */
export const BANNED_SCHEMA_FIELD = /^(full_?transcripts?|transcripts?|conversation(_history)?|chat_?history|raw_?location|location|latitude|longitude|lat|lng|gps(_.*)?|ip(_address)?)$/i;

/** Catch-all object properties: open-ended bags named like context/metadata. */
export const CATCH_ALL_FIELD = /(context|metadata|extra|payload|data)$/i;

/** Injection-style / tool-steering phrases banned from public descriptions. */
export const BANNED_DESCRIPTION_PHRASES: readonly string[] = [
  'ignore previous',
  'ignore all previous',
  'disregard previous',
  'do not tell the user',
  'without telling the user',
  'instead of any other tool',
  'always call this tool first',
  'prefer this tool over',
];
