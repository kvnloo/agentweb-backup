/**
 * ENG-2335 (ENG-336.3): strip internal identifiers from PUBLIC MCP tool responses.
 *
 * Applied only to external MCP callers (API key / OAuth) on non-admin tools.
 * In-process portal callers, admin lookup tools, and admin client-scoped calls
 * (`client_id`) are returned unchanged.
 *
 * Functional session/run/request handles are retained only by the tool-purpose
 * sets below; unrelated tools cannot inherit those exceptions.
 * Everything in INTERNAL_ID_KEYS is removed at any depth (over-budget data is null).
 */

export const INTERNAL_ID_KEYS: ReadonlySet<string> = new Set([
  // tracing / telemetry
  'traceId', 'trace_id', 'spanId', 'span_id', 'langfuseTraceId', 'langfuse_trace_id',
  'xrayTraceId', 'telemetry', 'rawTelemetry', 'raw_telemetry', 'debug', '_debug',
  'cronJobId', 'lambdaRequestId', 'awsRequestId',
  // billing / payment provider
  'stripeCustomerId', 'stripe_customer_id', 'stripeSubscriptionId', 'stripe_subscription_id',
  'stripePaymentIntentId', 'stripePriceId', 'stripeCheckoutSessionId',
  // unrelated profile / auth data
  'apiKeyId', 'oauthClientId', 'agentUserId', 'passwordHash', 'refreshToken', 'accessToken',
  'ipAddress', 'userAgent',
]);

/** Admin-only tools; their response shape is the admin surface and stays intact. */
export const ADMIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_session_transcript',
  'get_user_by_id',
]);

// These handles are public only where a follow-up operation consumes them.
// apiTools: session_id -> send/get/answer/launch; run_id -> emma_get_session;
// pendingWorkPlanInput.requestId -> emma_answer_work_plan_input.request_id.
const CONVERSATION_TOOLS = new Set([
  'emma_send_message', 'emma_get_session', 'emma_answer_question_deck',
  'emma_answer_work_plan_input', 'emma_launch_work_plan',
]);
const SESSION_TOOLS = new Set([
  ...CONVERSATION_TOOLS, 'emma_create_session', 'emma_list_sessions', 'get_chat_history',
  // Schedule rows/history expose sessions that emma_get_session can inspect.
  'list_scheduled_chats', 'manage_scheduled_chat', 'get_scheduled_chat_test_history',
]);
// workflowTools returns run_id for emma_get_session; schedule test history matches
// test_scheduled_chat/submit_scheduled_chat_variables results by runId.
// smartleadTools consumes runId in get/pause/cancel_smartlead_push.
const RUN_TOOLS = new Set([
  ...CONVERSATION_TOOLS, 'emma_run_marketing_task', 'test_scheduled_chat',
  'submit_scheduled_chat_variables', 'get_scheduled_chat_test_history',
  'get_smartlead_push_status', 'pause_smartlead_push', 'cancel_smartlead_push',
]);

function isPrivateKey(key: string, toolName: string): boolean {
  if (INTERNAL_ID_KEYS.has(key)) return true;
  if (key === 'sessionId' || key === 'session_id') return !SESSION_TOOLS.has(toolName);
  if (key === 'runId' || key === 'run_id') return !RUN_TOOLS.has(toolName);
  if (key === 'requestId' || key === 'request_id') return !CONVERSATION_TOOLS.has(toolName);
  return false;
}

/**
 * Object/array nesting budget. It bounds recursion, it is not a data-shape rule: the MCP envelope
 * and the tool's own payload wrapper spend ~8 levels before stored customer data starts, so the
 * old 32 nulled legitimate stored values from about level 25. Deeper than this is still null.
 */
const MAX_DEPTH = 128;

export function stripInternalIds(value: any, depth = 0, toolName = ''): any {
  // Bound total traversal, not just depth: shared graphs can expand exponentially.
  const ancestors = new WeakSet<object>();
  let remaining = 10000;
  function visit(value: any, depth: number): any {
  // Never return an unvisited subtree, including encoded JSON or cyclic input.
  if (depth > MAX_DEPTH || --remaining < 0) return null;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return value;
    let parsed: unknown;
    // Not JSON: plain text, returned as-is. Any other parser failure is unvisited data: fail closed.
    try { parsed = JSON.parse(value); } catch (err) { return err instanceof SyntaxError ? value : null; }
    // Encoded text is not structure: only object/array nesting spends the depth budget.
    const stripped = visit(parsed, depth);
    return JSON.stringify(stripped) === JSON.stringify(parsed)
      ? value : JSON.stringify(stripped, null, 2);
  }
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => visit(v, depth + 1));
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isPrivateKey(key, toolName))
      .map(([key, entry]) => [key, visit(entry, depth + 1)]));
  } finally {
    ancestors.delete(value);
  }
  }
  return visit(value, depth);
}

export function shouldSanitizePublicResponse(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  context: { externalMcp?: boolean; callerIsAdmin?: boolean },
): boolean {
  if (!context.externalMcp) return false;
  if (ADMIN_TOOL_NAMES.has(toolName)) return false;
  // `client_id` marks an admin acting for a client, whose answers keep their internal ids. The argument alone proves nothing: any caller can
  // add it to any tool (most tools ignore it), so it switches sanitising off only when the caller really is an admin.
  if (toolArgs && (toolArgs.client_id || toolArgs.clientId) && context.callerIsAdmin === true) return false;
  return true;
}

/** Sanitize a raw tool result (object, string, or MCP `{content:[...]}` envelope). */
export function sanitizePublicToolResult(result: any, toolName = ''): any {
  return stripInternalIds(result, 0, toolName);
}
