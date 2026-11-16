import type { EvaluationRecord } from './evaluationStore';

/** Reserved at provisioning; immutable identity survives stale user/credential indexes. */
export function isEvaluationUser(userId: unknown): boolean {
  return typeof userId === 'string' && userId.startsWith('eval_');
}

export class EvaluationDenied extends Error {
  constructor(message = 'Evaluation access denied') { super(message); }
}

type ToolMatcher = (name: string) => boolean;
const exact = (...names: string[]): ToolMatcher => { const set = new Set(names); return name => set.has(name); };
const prefix = (...prefixes: string[]): ToolMatcher => name => prefixes.some(p => name.startsWith(p));
const pattern = (regex: RegExp): ToolMatcher => name => regex.test(name);
const anyOf = (...matchers: ToolMatcher[]): ToolMatcher => name => matchers.some(m => m(name));

/**
 * Tool classes a sandbox principal may be denied (ENG-1906 decision 6). Anything that does not
 * match a class — Meta tools, generation, search, knowledge base, work plans, internal CRM,
 * landing-page generation, unknown future tools — is allowed and reaches its normal handler.
 * `install_skills` is deliberately outside `connectors`: it only expands the model's tool list
 * and is required for any non-foundation tool to be reachable at all.
 */
export const SANDBOX_TOOL_CLASSES: Record<string, ToolMatcher> = {
  lifecycle: exact('evaluation_workspace'),
  connectors: anyOf(
    exact('connect_account', 'install_mcp_server'),
    name => name.startsWith('install_') && name !== 'install_skills',
    prefix('configure_mcp'),
    pattern(/(^|_)mcp_server/),
  ),
  sends: exact(
    'send_email', 'send_email_to_lead', 'send_email_from_sender', 'notify_session', 'send_for_review',
    'send_gtm_status_report', 'report_product_issues', 'email', 'slack_send_message', 'enqueue_human_eval',
    'fathom_route_action_items', 'emma_send_message', 'manage_crm_sequence',
  ),
  social: anyOf(
    prefix('linkedin_', 'twitter_', 'google_calendar_'),
    exact('post_on_connected_account', 'post_on_account', 'import_leads_from_search'),
  ),
  publish: anyOf(
    prefix('publish_'),
    exact('deploy_landing_page', 'configure_landing_page_subdomain', 'enable_lead_list_public_access',
      'revert_landing_page_publish', 'share_landing_page_with_org', 'enable_session_tracking'),
  ),
  third_party_writes: anyOf(
    exact('call_google_ads_api', 'call_google_ads_reporting_api', 'call_hubspot_api', 'call_attio_api',
      'call_linkedin_marketing_api', 'call_linkedin_ads_insights_api', 'write_clickup_doc', 'create_clickup_task',
      'create_google_doc', 'update_google_doc', 'create_google_sheet', 'update_google_sheet'),
    prefix('enrich_leads', 'google_drive_'),
  ),
  browser: anyOf(
    prefix('playwright_browser_'),
    pattern(/(^|_)browser_/),
    exact('open_site_signin', 'solve_captcha', 'request_user_captcha_solution', 'get_temp_email',
      'check_temp_inbox', 'navigate_to', 'run_local_agent_task', 'read_verification_code'),
  ),
  automation: exact(
    'coding_agent', 'manage_scheduled_chat', 'test_scheduled_chat', 'submit_scheduled_chat_variables',
    'manage_schedule', 'create_schedule_from_template', 'manage_schedule_template',
  ),
};

export const SANDBOX_TOOL_CLASS_NAMES: readonly string[] = Object.freeze(Object.keys(SANDBOX_TOOL_CLASSES));

export function classifySandboxTool(name: string): string | null {
  for (const [toolClass, matches] of Object.entries(SANDBOX_TOOL_CLASSES)) if (matches(name)) return toolClass;
  return null;
}

export async function requireActiveEvaluation(userId: string) {
  const { evaluationStore } = await import('./evaluationStore');
  const record = await evaluationStore.get(userId);
  if (!record || record.userId !== userId || record.status !== 'active' || record.lifecycleState !== undefined ||
      !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    throw new EvaluationDenied();
  }
  return record;
}

/**
 * Class-based denial from the policy record; the lifecycle tool is denied for every sandbox
 * principal regardless of the record. Reads and every unclassified tool run normally.
 */
export async function enforceEvaluationTool(userId: unknown, name: string, extraContext?: Record<string, unknown>) {
  if ((isEvaluationUser(userId) || isEvaluationUser(extraContext?.userId)) &&
      extraContext && 'userId' in extraContext && extraContext.userId !== userId) throw new EvaluationDenied();
  if (typeof userId !== 'string' || !isEvaluationUser(userId)) return;
  const record = await requireActiveEvaluation(userId);
  const toolClass = classifySandboxTool(name);
  // A row without an explicit class list (legacy ENG-1870 rows) denies every class.
  const denied = Array.isArray(record.deniedToolClasses) ? record.deniedToolClasses : SANDBOX_TOOL_CLASS_NAMES;
  if (toolClass && (toolClass === 'lifecycle' || denied.includes(toolClass))) {
    throw new EvaluationDenied(`Tool "${name}" is not available in this sandbox workspace (${toolClass}).`);
  }
}

/**
 * ENG-1948: whether `evaluation_workspace` should be offered in a tool list at all. Only a
 * direct, attended admin can ever pass `requireEvaluationAdmin` (reviewers are assigned admins'
 * peers reached the same way), so offering it to delegated, shared, unattended/scheduled,
 * non-admin or sandbox principals only produces guaranteed `EvaluationDenied` turns. This is a
 * listing filter only; the execute-time checks above/below stay authoritative.
 */
export function shouldOfferEvaluationWorkspace(input: {
  userId: string; isAdmin: boolean; isDelegatedAccess?: boolean; isInteractiveShare?: boolean; isUnattendedRun?: boolean;
}): boolean {
  return input.isAdmin === true && !isEvaluationUser(input.userId) && input.isDelegatedAccess !== true &&
    input.isInteractiveShare !== true && input.isUnattendedRun !== true;
}

/** Lifecycle mutations require a current app/Emma administrator, never ambient MCP authority. */
export async function requireEvaluationAdmin(userId: string, context?: Record<string, unknown>) {
  if (isEvaluationUser(userId) || context?.externalMcp || context?.isInternal || context?.delegateInfo ||
      context?.isDelegatedAdmin || context?.isDelegatedAccess) throw new EvaluationDenied();
  const { userDb } = await import('./db');
  const admin = await userDb.getUserByIdConsistent(userId);
  if (!admin || admin.userId !== userId || admin.isAdmin !== true || admin.isActive !== true) throw new EvaluationDenied();
}

/** Reviewers must be live, direct principals; the store checks explicit evaluation assignment. */
export async function requireEvaluationReviewer(userId: string, context?: Record<string, unknown>) {
  if (isEvaluationUser(userId) || context?.externalMcp || context?.isInternal || context?.delegateInfo ||
      context?.isDelegatedAdmin || context?.isDelegatedAccess) throw new EvaluationDenied();
  const { userDb } = await import('./db');
  const reviewer = await userDb.getUserByIdConsistent(userId);
  if (!reviewer || reviewer.userId !== userId || reviewer.isActive !== true) throw new EvaluationDenied();
}

/** What the portal needs to render the sandbox badge; carried on `/api/auth/me`. */
export function sandboxInfo(record: EvaluationRecord) {
  return {
    isSandbox: true as const,
    // Rows provisioned before ENG-1907 carry no label.
    label: record.label || 'Sandbox',
    datasetId: record.datasetId ?? null,
    datasetVersion: record.datasetVersion ?? null,
    expiresAt: record.expiresAt,
  };
}
