/**
 * ENG-1685 spike leaf: routes the existing `email` tool's actions (search,
 * list, get) through Agentic Fabriq's Gmail connector instead of the
 * direct `emailProviderService` path — called ONLY from the flagged branch
 * in `agentMode/core/toolDispatch.ts`, never registered as a real
 * `IEmailService` provider (that would silently redirect ALL gmail traffic
 * the moment it's imported, which is exactly what AC5 forbids).
 *
 * Deliberately mirrors `email` tool's args/response shape as closely as
 * possible so the spike is a true A/B on the same tool contract, not two
 * different response schemas the model has to be told apart.
 */

import { isDeepStrictEqual } from 'node:util';
import { getAgenticFabriqApiBaseUrl, getAgenticFabriqAppCredentials } from './config';
import { agenticFabriqTokenCache } from './tokenCache';
import { agenticFabriqClient } from './client';
import { agenticFabriqMcpBridge, resolveMcpExternalUrl } from './mcpBridge';
import { AgenticFabriqError, AgenticFabriqUnsupportedMailboxError } from './errors';
import type { McpToolDescriptor } from './types';
import { bootstrapEmailProviders, resolveEmailAccount, withAccessGuard } from '../../services/emailProviderService';
import { verifiedConnectionIdForAccount } from './pendingConnectStore';

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

type ReadAction = 'search' | 'list' | 'get';

export interface ReviewedGmailContract {
  name: string;
  inputSchema: Record<string, unknown>;
  mapArgs: (args: AgenticFabriqEmailToolArgs, connectionId: string) => Record<string, unknown>;
}

// No live identity/schema/argument mapping has been reviewed yet. Keep empty:
// discovery is evidence to review, never permission to execute guessed tools.
const REVIEWED_GMAIL_CONTRACTS: Readonly<Partial<Record<ReadAction, ReviewedGmailContract>>> = Object.freeze({});

/** Exact identity and schema pinning. Duplicate identities fail closed. */
export function pickGmailToolForAction(
  tools: McpToolDescriptor[],
  action: AgenticFabriqEmailToolArgs['action'],
  contracts = REVIEWED_GMAIL_CONTRACTS,
): McpToolDescriptor | null {
  if (!['search', 'list', 'get'].includes(action)) return null;
  const contract = contracts[action as ReadAction];
  if (!contract || !Array.isArray(tools)) return null;
  const candidates = tools.filter((tool) => tool && tool.name === contract.name);
  return candidates.length === 1 && isDeepStrictEqual(candidates[0].inputSchema, contract.inputSchema)
    ? candidates[0] : null;
}

/** Executes one email action only after exact owner-mailbox authorization. */
export async function runEmailToolThroughAgenticFabriq(
  args: AgenticFabriqEmailToolArgs,
  rawUserId: string,
): Promise<AgenticFabriqEmailBridgeResult> {
  const startedAtMs = Date.now();
  if (!args || !['search', 'list', 'get'].includes(args.action)) {
    throw new AgenticFabriqError('Agentic Fabriq canary is read-only.');
  }
  if (typeof args.account_id !== 'string' || !args.account_id || args.account_id.length > 200) throw new AgenticFabriqUnsupportedMailboxError();
  try {
    await bootstrapEmailProviders();
    const operation = 'read';
    const resolved = await resolveEmailAccount(rawUserId, args.account_id, operation);
    // Shared mailboxes are unsupported in this spike. Fail closed for reads as
    // well as sends because Fabriq tokens are scoped to the caller, not owner.
    if (resolved.platform !== 'gmail' || resolved.ownerUserId !== rawUserId) {
      throw new AgenticFabriqUnsupportedMailboxError();
    }
    const connectionId = verifiedConnectionIdForAccount(resolved.accountId, rawUserId);
    const { appId } = await getAgenticFabriqAppCredentials();

    const connections = await agenticFabriqClient.listConnections(appId, rawUserId);
    const matchingConnections = connections.filter((c) => c.tool === 'gmail' && c.connection_id === connectionId);
    const gmailConnection = connectionId && matchingConnections.length === 1 ? matchingConnections[0] : undefined;
    // "A LISTED CONNECTION IS NOT A WORKING ONE" — key every user-facing state
    // off status === 'connected', never off the row merely existing.
    if (!connectionId || !gmailConnection || gmailConnection.status !== 'connected') {
      return {
        outcome: {
          error:
            'No connected Gmail account via the Agentic Fabriq spike. Complete the connect flow first.',
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
    const mcpUrl = resolveMcpExternalUrl(getAgenticFabriqApiBaseUrl(), token.mcpUrl || undefined);

    const tools = await agenticFabriqMcpBridge.listTools(mcpUrl, token.accessToken);
    const matched = pickGmailToolForAction(tools, args.action);
    if (!matched) {
      return {
        outcome: {
          error:
            'No reviewed compatible Gmail tool is available for this read-only canary.',
        },
        spikeMeta: { matchedToolName: null, latencyMs: Date.now() - startedAtMs, discoveredToolCount: tools.length, connectionStatus: gmailConnection.status },
      };
    }

    const contract = REVIEWED_GMAIL_CONTRACTS[args.action as ReadAction]!;
    const mcpArgs = contract.mapArgs(args, connectionId);
    const outcome = await withAccessGuard(rawUserId, resolved, operation, () =>
      agenticFabriqMcpBridge.callTool(mcpUrl, token.accessToken, matched.name, mcpArgs));

    return {
      outcome,
      spikeMeta: {
        matchedToolName: matched.name,
        latencyMs: Date.now() - startedAtMs,
        discoveredToolCount: tools.length,
        connectionStatus: gmailConnection.status,
      },
    };
  } catch (error) {
    if (error instanceof AgenticFabriqUnsupportedMailboxError) throw new AgenticFabriqUnsupportedMailboxError();
    // Resolver and network failures can contain account IDs, paths, or secrets.
    // This boundary also serves the below-LLM benchmark, outside toolDispatch.
    throw new AgenticFabriqError('Agentic Fabriq canary request failed.');
  }
}
