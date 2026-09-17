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
import { AgenticFabriqError, AgenticFabriqUnsupportedMailboxError } from './errors';
import type { McpToolDescriptor } from './types';
import { bootstrapEmailProviders, resolveEmailAccount, withAccessGuard } from '../../services/emailProviderService';
import { connectionIdForAccount } from './pendingConnectStore';

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
  const keywords = ACTION_KEYWORDS[action];
  let best: { tool: McpToolDescriptor; score: number } | null = null;
  for (const tool of tools) {
    if (!toolBelongsToGmail(tool.name)) continue;
    const score = keywords.filter((keyword) => tool.name.toLowerCase().includes(keyword)).length;
    if (score > 0 && (!best || score > best.score)) best = { tool, score };
  }
  return best?.tool ?? null;
}

/** Executes one email action only after exact owner-mailbox authorization. */
export async function runEmailToolThroughAgenticFabriq(
  args: AgenticFabriqEmailToolArgs,
  rawUserId: string,
): Promise<AgenticFabriqEmailBridgeResult> {
  const startedAtMs = Date.now();
  if (!args.account_id || args.account_id.length > 200) throw new AgenticFabriqUnsupportedMailboxError();
  await bootstrapEmailProviders();
  const operation = args.action === 'send' ? 'send' : 'read';
  const resolved = await resolveEmailAccount(rawUserId, args.account_id, operation);
  // Shared mailboxes are unsupported in this spike. Fail closed for reads as
  // well as sends because Fabriq tokens are scoped to the caller, not owner.
  if (resolved.platform !== 'gmail' || resolved.ownerUserId !== rawUserId) {
    throw new AgenticFabriqUnsupportedMailboxError();
  }
  const connectionId = connectionIdForAccount(resolved.accountId);
  const { appId } = await getAgenticFabriqAppCredentials();

  const connections = await agenticFabriqClient.listConnections(appId, rawUserId);
  const matchingConnections = connections.filter((c) => c.tool === 'gmail' && c.connection_id === connectionId);
  const gmailConnection = matchingConnections.length === 1 ? matchingConnections[0] : undefined;
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

  const token = await agenticFabriqTokenCache.getFreshToken(appId, rawUserId, connectionId);
  const mcpUrl = resolveMcpExternalUrl(getAgenticFabriqApiBaseUrl(), token.mcpUrl);

  const tools = await agenticFabriqMcpBridge.listTools(mcpUrl, token.accessToken);
  const matched = pickGmailToolForAction(tools, args.action);
  if (!matched) {
    return {
      outcome: {
        error:
          `No Agentic Fabriq Gmail tool matched action "${args.action}" among ${tools.length} discovered tools.`,
      },
      spikeMeta: { matchedToolName: null, latencyMs: Date.now() - startedAtMs, discoveredToolCount: tools.length, connectionStatus: gmailConnection.status },
    };
  }

  const mcpArgs = mapEmailArgsToMcpArgs(args, connectionId);
  let outcome: unknown;
  try {
    outcome = await withAccessGuard(rawUserId, resolved, operation, () =>
      agenticFabriqMcpBridge.callTool(mcpUrl, token.accessToken, matched.name, mcpArgs));
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
function mapEmailArgsToMcpArgs(args: AgenticFabriqEmailToolArgs, connectionId: string): Record<string, unknown> {
  const binding = { account_id: args.account_id, connection_id: connectionId };
  const maxResults = Math.max(1, Math.min(Number(args.max_results) || 10, 50));
  switch (args.action) {
    case 'search':
      return { ...binding, query: args.query, max_results: maxResults };
    case 'list':
      return { ...binding, folder: args.folder ?? 'INBOX', max_results: maxResults };
    case 'get':
      return { ...binding, message_ids: Array.isArray(args.message_ids) ? args.message_ids.slice(0, 50) : [] };
    case 'send':
      return {
        ...binding,
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
