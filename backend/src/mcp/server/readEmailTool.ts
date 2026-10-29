/**
 * `read_email` — the external-MCP, read-only counterpart of `send_email`.
 *
 * `send_email` is internalOnly (ENG-974) because it bundles an outbound action.
 * This tool exposes only its read actions (search | list | get) to external
 * callers, behind four controls:
 *
 *   1. Opt-in scope: `requiredScope: email:read`. Only an `aw_` key that
 *      explicitly holds `email:read` may call it — `tools:execute` does not
 *      imply it and default keys do not get it (apiKeyScopes.ts). OAuth and
 *      anonymous callers are refused (mcpServer.ts + registry.execute).
 *   2. Read actions only: anything other than search|list|get is refused here,
 *      before any request is made. No send/reply fields exist in the schema,
 *      and the body forwarded to the route is built field by field.
 *   3. Own mailbox only for external callers: the route refuses a mailbox whose
 *      owner is not the caller (org-shared/teammate accounts).
 *   4. Per-user rate limit + a structured audit line with no email content.
 */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { API_KEY_SCOPE_EMAIL_READ } from './apiKeyScopes';

export const READ_EMAIL_ACTIONS = ['search', 'list', 'get'] as const;

export const READ_EMAIL_RATE_LIMIT = 60;
export const READ_EMAIL_RATE_WINDOW_MS = 10 * 60 * 1000;

// Per-user sliding window. Entries are bounded by READ_EMAIL_RATE_LIMIT per
// user, and only users holding an email:read key can add one.
const callLog = new Map<string, number[]>();

export function resetReadEmailRateLimit(): void {
  callLog.clear();
}

function consumeRateLimit(userId: string, now = Date.now()): boolean {
  const recent = (callLog.get(userId) ?? []).filter((t) => now - t < READ_EMAIL_RATE_WINDOW_MS);
  if (recent.length >= READ_EMAIL_RATE_LIMIT) {
    callLog.set(userId, recent);
    return false;
  }
  recent.push(now);
  callLog.set(userId, recent);
  return true;
}

mcpToolRegistry.register({
  name: 'read_email',
  readOnly: true,
  requiredScope: API_KEY_SCOPE_EMAIL_READ,
  requiresUserAccount: true,
  definition: {
    name: 'read_email',
    description:
      'Read-only access to your own connected email accounts (Gmail, Outlook): search, list a folder, or get messages by ID. ' +
      "Requires an API key with the 'email:read' scope. Cannot send or reply, and cannot read mailboxes shared by teammates.",
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Email account ID from list_connected_accounts' },
        action: { type: 'string', enum: [...READ_EMAIL_ACTIONS], description: 'Read action to perform' },
        query: { type: 'string', description: 'Search query (search action)' },
        folder: { type: 'string', description: 'Folder to list (list action)', default: 'INBOX' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'Message IDs (get action)' },
        max_results: { type: 'number', description: 'Max results (search/list, capped at 50)', default: 10 },
      },
      required: ['account_id', 'action'],
    },
  },
  execute: async (args: any, context: any) => {
    const action = args?.action;
    if (!(READ_EMAIL_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`read_email only supports ${READ_EMAIL_ACTIONS.join(', ')}; action "${action}" is not allowed.`);
    }

    const external = context?.externalMcp === true;
    const userId = context?.userId;
    if (external) {
      if (!userId) throw new Error('read_email requires an authenticated user.');
      if (!consumeRateLimit(userId)) {
        throw new Error(
          `read_email rate limit exceeded (${READ_EMAIL_RATE_LIMIT} calls per ${READ_EMAIL_RATE_WINDOW_MS / 60000} minutes). Try again later.`
        );
      }
    }

    const body: Record<string, unknown> = { account_id: args.account_id, action };
    if (action === 'search') body.query = args.query;
    if (action === 'list') body.folder = args.folder;
    if (action === 'get') body.message_ids = args.message_ids;
    if (action !== 'get' && args.max_results !== undefined) body.max_results = args.max_results;
    if (external) body.own_mailbox_only = true;

    const data = await mcpFetch({ method: 'POST', path: '/api/emma/email', context: ctx(context), body });

    console.info(JSON.stringify({
      event: 'mcp_read_email',
      userId,
      accountId: args.account_id,
      action,
      count: typeof data?.count === 'number' ? data.count : null,
      external,
    }));
    return jsonResult(data);
  },
});
