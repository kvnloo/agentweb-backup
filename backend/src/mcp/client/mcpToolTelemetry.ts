/**
 * mcpToolTelemetry — pure, structured telemetry for MCP tool calls (ENG-107).
 *
 * Before this module, both MCP `execute` closures in mcpClientService.ts emitted
 * only unstructured console text (`[MCP-DEBUG] Calling tool ...`, `[MCP-RETRY] ...
 * failed on attempt N/M`, `[MCP Tool Execution Error (...)`). None of the
 * reliability dimensions the failure-clustering policy needs were captured as
 * structured fields: server name, MCP session id, transport type, retry count, or
 * a normalized error class. Browser retry vs final failure was only distinguishable
 * by the log prefix/level, not by a queryable field.
 *
 * This helper produces a single normalized, JSON-serializable payload from those
 * dimensions and reuses the existing runtime-spine error taxonomy
 * (`classifyToolErrorClass`) rather than inventing a parallel one — a single coarse,
 * stable error taxonomy at the tool boundary.
 *
 * Prior art: Claude Code's src/tools boundary — one coarse, stable error taxonomy +
 * structured telemetry at the tool dispatch edge, not ad-hoc strings.
 *
 * PURE: no I/O, no SDK, no service imports beyond the pure classifier. The caller
 * does the actual `console.log(JSON.stringify(buildMcpToolTelemetry(...)))`.
 */

import { classifyToolErrorClass } from '../../utils/toolErrorClassifier';

export type McpToolTelemetryPhase = 'call' | 'retry' | 'final_failure';

export interface McpToolTelemetryInput {
  /** Underlying MCP server name (e.g. "playwright-server"). */
  serverName: string;
  /** Exposed (possibly prefixed) tool name the model called. */
  toolName: string;
  /** Transport type for the server's connection. */
  transport: 'sse' | 'stdio' | 'streamable-http';
  /** Chat session id (truncated for safety in the payload). */
  chatSessionId?: string;
  /** MCP transport session id, or 'NO_SESSION_ID' when absent (truncated). */
  mcpSessionId?: string;
  /** 1-based attempt counter. */
  attempt: number;
  /** Total attempts allowed for this tool (1 for non-browser tools). */
  maxAttempts: number;
  /** Lifecycle phase this telemetry line represents. */
  phase: McpToolTelemetryPhase;
  /** Raw error — only meaningful on 'retry' / 'final_failure'. */
  error?: unknown;
}

export interface McpToolTelemetryPayload {
  event: 'mcp_tool_call';
  serverName: string;
  toolName: string;
  transport: string;
  chatSessionId: string;
  mcpSessionId: string;
  retryCount: number;
  maxAttempts: number;
  phase: McpToolTelemetryPhase;
  errorClass?: string;
  errorMessage?: string;
}

const SESSION_ID_PREFIX_LEN = 8;

/**
 * Truncate a session-style id to its first 8 chars (matching the existing
 * `.substring(0, 8)` logging convention) so full session ids — which can be
 * sensitive / correlatable — never land in telemetry. Falls back to a sentinel.
 */
function truncateSessionId(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (value === 'NO_SESSION_ID') return value;
  return value.substring(0, SESSION_ID_PREFIX_LEN);
}

/**
 * Redact secrets that occasionally leak into MCP tool error messages / args:
 * bearer tokens, api/access/refresh tokens, passwords, and long opaque
 * hex/base64/JWT blobs. Best-effort masking — preserves surrounding text so the
 * normalized error class (computed from the raw error) is still meaningful.
 */
export function redactSensitive(input: unknown): string {
  let msg: string;
  if (typeof input === 'string') {
    msg = input;
  } else if (input instanceof Error) {
    msg = input.message ?? '';
  } else if (input === undefined || input === null) {
    msg = '';
  } else {
    msg = String(input);
  }

  // Bearer <token> (JWTs contain '.', so include it in the token char class).
  msg = msg.replace(/\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]');

  // key=value / key: value for sensitive keys (quoted or bare value).
  msg = msg.replace(
    /\b(access_token|refresh_token|api[_-]?key|apikey|client_secret|password|passwd|secret|token|authorization)\b(\s*[=:]\s*)("?)([^\s"'&,;}]+)\3/gi,
    '$1$2[REDACTED]'
  );

  // Long opaque blobs not caught above (raw secrets, JWT segments >= 24 chars).
  msg = msg.replace(/\b[A-Za-z0-9\-_]{24,}(?:\.[A-Za-z0-9\-_]{10,}){0,2}\b/g, '[REDACTED]');

  return msg;
}

/**
 * Build a normalized, JSON-serializable telemetry payload for one MCP tool-call
 * lifecycle event. On failure phases, attaches the normalized error class (from
 * the shared classifier) and a redacted error message.
 */
export function buildMcpToolTelemetry(input: McpToolTelemetryInput): McpToolTelemetryPayload {
  const payload: McpToolTelemetryPayload = {
    event: 'mcp_tool_call',
    serverName: input.serverName,
    toolName: input.toolName,
    transport: input.transport,
    chatSessionId: truncateSessionId(input.chatSessionId, 'NO_SESSION_ID'),
    mcpSessionId: truncateSessionId(input.mcpSessionId, 'NO_SESSION_ID'),
    retryCount: Math.max(0, input.attempt - 1),
    maxAttempts: input.maxAttempts,
    phase: input.phase,
  };

  if (input.phase === 'retry' || input.phase === 'final_failure') {
    payload.errorClass = classifyToolErrorClass(input.error);
    payload.errorMessage = redactSensitive(input.error);
  }

  return payload;
}
