/**
 * ENG-2335 (ENG-336.3): strip internal identifiers from PUBLIC MCP tool responses.
 *
 * Applied only to external MCP callers (API key / OAuth) on non-admin tools.
 * In-process portal callers, admin lookup tools, and admin client-scoped calls
 * (`client_id`) are returned unchanged.
 *
 * Kept on purpose (required by the tool's purpose, the client must echo them back):
 *   - sessionId / session_id : continue a conversation (emma_send_message, get_chat_history)
 *   - runId / run_id         : poll a detached run or schedule test run
 *   - requestId / request_id : answer a pendingWorkPlanInput
 * Everything in INTERNAL_ID_KEYS is removed at any depth.
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

export function stripInternalIds<T>(value: T, depth = 0): T {
  if (depth > 32 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripInternalIds(v, depth + 1)) as any;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (INTERNAL_ID_KEYS.has(k)) continue;
    out[k] = stripInternalIds(v, depth + 1);
  }
  return out as T;
}

function sanitizeText(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.stringify(stripInternalIds(JSON.parse(text)), null, 2);
  } catch {
    return text;
  }
}

export function shouldSanitizePublicResponse(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  context: { externalMcp?: boolean },
): boolean {
  if (!context.externalMcp) return false;
  if (ADMIN_TOOL_NAMES.has(toolName)) return false;
  if (toolArgs && (toolArgs.client_id || toolArgs.clientId)) return false;
  return true;
}

/** Sanitize a raw tool result (object, string, or MCP `{content:[...]}` envelope). */
export function sanitizePublicToolResult(result: any): any {
  if (typeof result === 'string') return sanitizeText(result);
  if (result && typeof result === 'object' && Array.isArray(result.content)) {
    return {
      ...result,
      content: result.content.map((c: any) =>
        c && c.type === 'text' && typeof c.text === 'string' ? { ...c, text: sanitizeText(c.text) } : c,
      ),
    };
  }
  return stripInternalIds(result);
}
