/**
 * ENG-1685 spike leaf: routes the existing `email` tool's actions (search,
 * list, get, send) through Agentic Fabriq's Gmail connector instead of the
 * direct `emailProviderService` path — called ONLY from the flagged branch
 * in `agentMode/core/toolDispatch.ts`, never registered as a real
 * `IEmailService` provider (that would silently redirect ALL gmail traffic
 * the moment it's imported, which is exactly what AC5 forbids).
 *
 * Deliberately mirrors `email` tool's args/response shape as closely as
 * possible so the spike is a true A/B on the same tool contract, not two
 * different response schemas the model has to be told apart.
 */

import { getAgenticFabriqApiBaseUrl, getAgenticFabriqAppCredentials } from './config';
import { agenticFabriqTokenCache } from './tokenCache';
import { agenticFabriqClient } from './client';
import { agenticFabriqMcpBridge, resolveMcpExternalUrl } from './mcpBridge';
import { AgenticFabriqError } from './errors';
import type { McpToolDescriptor } from './types';

export interface AgenticFabriqEmailToolArgs {
  account_id?: string;
  action: 'search' | 'list' | 'get' | 'send';
  query?: string;
  folder?: string;
  message_ids?: string[];
  max_results?: number;
  to?: string | string[];
  subject?: string;
  body?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to_message_id?: string;
  is_html?: boolean;
}

export interface AgenticFabriqEmailBridgeResult {
  outcome: unknown; // shaped to mirror the direct `email` tool's return value, best-effort
  spikeMeta: {
    matchedToolName: string | null;
    latencyMs: number;
    discoveredToolCount: number;
    connectionStatus: string | null;
  };
}

const GMAIL_TOOL_SLUGS = ['gmail', 'google_gmail'] as const;

/**
 * Trap #6 from the vendor's setup notes: tool names may be vendor-prefixed
 * (google_gmail_archive_message belongs to gmail) — check the first TWO
 * underscore segments against known slugs, not just the first.
 */
function toolBelongsToGmail(toolName: string): boolean {
  const segments = toolName.split('_');
  const firstOne = segments[0];
  const firstTwo = segments.slice(0, 2).join('_');
  return (GMAIL_TOOL_SLUGS as readonly string[]).includes(firstOne) ||
    (GMAIL_TOOL_SLUGS as readonly string[]).includes(firstTwo);
}

const ACTION_KEYWORDS: Record<AgenticFabriqEmailToolArgs['action'], string[]> = {
  search: ['search', 'query', 'find'],
  list: ['list', 'messages'],
  get: ['get', 'read', 'fetch'],
  send: ['send', 'compose', 'reply'],
};

/**
 * Picks the best-matching discovered Gmail-surface tool for a given `email`
 * action. Exported standalone so it's unit-testable against a canned tool
 * list without any network — the actual live names are unknown until AF's
 * tools/list is called for real, per "Do NOT invent tool names."
 */
export function pickGmailToolForAction(
  tools: McpToolDescriptor[],
  action: AgenticFabriqEmailToolArgs['action'],
): McpToolDescriptor | null {
  const gmailTools = tools.filter((t) => toolBelongsToGmail(t.name));
  if (gmailTools.length === 0) return null;

  const keywords = ACTION_KEYWORDS[action];
  const scored = gmailTools
    .map((t) => ({ tool: t, score: keywords.filter((k) => t.name.toLowerCase().includes(k)).length }))
    .sort((a, b) => b.score - a.score);

  // Refuse a zero-score "best" match — that's a genuine coverage gap (AC4d),
  // not a guess worth acting on. A send action must never silently fall
  // through to whatever gmail tool happened to sort first.
  if (scored[0].score === 0) return null;
  return scored[0].tool;
}

export async function runEmailToolThroughAgenticFabriq(
  args: AgenticFabriqEmailToolArgs,
  rawUserId: string,
): Promise<AgenticFabriqEmailBridgeResult> {
  const startedAtMs = Date.now();
  const { appId } = await getAgenticFabriqAppCredentials();

  const connections = await agenticFabriqClient.listConnections(appId, rawUserId);
  const gmailConnection = connections.find((c) => c.tool === 'gmail');
  // "A LISTED CONNECTION IS NOT A WORKING ONE" — key every user-facing state
  // off status === 'connected', never off the row merely existing.
  if (!gmailConnection || gmailConnection.status !== 'connected') {
    return {
      outcome: {
        error:
          'No connected Gmail account via the Agentic Fabriq spike for this user. ' +
          'Complete the connect flow first (GET /api/agentic-fabriq-spike/gmail/initiate).',
      },
      spikeMeta: {
        matchedToolName: null,
        latencyMs: Date.now() - startedAtMs,
        discoveredToolCount: 0,
        connectionStatus: gmailConnection?.status ?? null,
      },
    };
  }

  const token = await agenticFabriqTokenCache.getFreshToken(appId, rawUserId);
  const mcpUrl = resolveMcpExternalUrl(getAgenticFabriqApiBaseUrl(), token.mcpUrl);

  const tools = await agenticFabriqMcpBridge.listTools(mcpUrl, token.accessToken);
  const matched = pickGmailToolForAction(tools, args.action);
  if (!matched) {
    return {
      outcome: {
        error:
          `No Agentic Fabriq Gmail tool matched action "${args.action}" among ${tools.length} discovered tools ` +
          `(${tools.map((t) => t.name).join(', ') || 'none'}). This is a real coverage gap for the spike, not a bug to paper over.`,
      },
      spikeMeta: { matchedToolName: null, latencyMs: Date.now() - startedAtMs, discoveredToolCount: tools.length, connectionStatus: gmailConnection.status },
    };
  }

  const mcpArgs = mapEmailArgsToMcpArgs(args);
  let outcome: unknown;
  try {
    outcome = await agenticFabriqMcpBridge.callTool(mcpUrl, token.accessToken, matched.name, mcpArgs);
  } catch (err) {
    if (err instanceof AgenticFabriqError) throw err; // surfaced, never retried under a different identity
    throw err;
  }

  return {
    outcome,
    spikeMeta: {
      matchedToolName: matched.name,
      latencyMs: Date.now() - startedAtMs,
      discoveredToolCount: tools.length,
      connectionStatus: gmailConnection.status,
    },
  };
}

/**
 * Best-effort arg shape translation. AF's actual Gmail tool schemas are
 * unknown until discovered live — this maps our own `email` tool's arg names
 * to the most likely equivalents and passes the rest through unchanged, so a
 * live run surfaces real schema mismatches (a genuine AC4d coverage gap)
 * instead of this bridge silently swallowing them.
 */
function mapEmailArgsToMcpArgs(args: AgenticFabriqEmailToolArgs): Record<string, unknown> {
  switch (args.action) {
    case 'search':
      return { query: args.query, max_results: args.max_results ?? 10 };
    case 'list':
      return { folder: args.folder ?? 'INBOX', max_results: args.max_results ?? 20 };
    case 'get':
      return { message_ids: args.message_ids };
    case 'send':
      return {
        to: args.to,
        subject: args.subject,
        body: args.body,
        cc: args.cc,
        bcc: args.bcc,
        reply_to_message_id: args.reply_to_message_id,
        is_html: args.is_html ?? false,
      };
    default:
      return {};
  }
}
