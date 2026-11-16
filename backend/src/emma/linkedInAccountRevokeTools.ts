/**
 * ENG-1153: Emma capability to inspect and revoke a LinkedIn Outreach (Unipile)
 * connection and neutralize its queued social-engagement actions — the operation
 * that previously required direct production AWS access.
 *
 * Scope is the caller's own user record only (connected_accounts on that user),
 * so another tenant's account id simply is not found. ENG-3108: inspect also
 * lists LinkedIn accounts a teammate shared with the caller's organization,
 * marked sharedByTeammate / revocableByCaller:false, so its list matches
 * list_connected_accounts. Revoke and queued actions stay own-accounts-only. Revocation reuses the same
 * path as DELETE /connected-accounts/unipile/:accountId, including the org-shared
 * owner guard. Queued actions are paused (status 'paused'), not deleted: the
 * executor only picks up status 'active', and the row stays as audit evidence.
 */
import { emmaToolRegistry } from './registry';
import { scheduleDb } from '../services/db';
import {
  getAccountsByUserId,
  getAccountsWithOwnerIncludingOrgShared,
  deleteAccountById,
} from '../services/connectedAccountsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

const PLATFORM = 'unipile';
const ACTION_TYPE = 'social_engagement_action';

function callerId(context: any): string {
  const userId = context?.userId || context?.agentUserId;
  if (!userId) throw new Error('Authentication required: no user context');
  return userId;
}

async function linkedInAccounts(userId: string) {
  const accounts = await getAccountsByUserId(userId);
  return accounts.filter((a: any) => a?.platform === PLATFORM);
}

/** Pending engagement actions (active, not yet run) where this account engages or owns the post. */
async function queuedActionsFor(userId: string, accountId: string): Promise<any[]> {
  const schedules = (await scheduleDb.getSchedulesByUserId(userId)) || [];
  return schedules.filter((s: any) => {
    if (s?.type !== ACTION_TYPE || s?.status !== 'active') return false;
    const v = s.variableValues || {};
    return v.engagingAccountId === accountId || v.ownerAccountId === accountId;
  });
}

function summarizeAction(s: any) {
  const v = s.variableValues || {};
  return {
    scheduleId: s.scheduleId,
    actionType: v.actionType,
    targetType: v.targetType,
    postId: v.postId,
    nextRunTime: s.nextRunTime,
    role: v.engagingAccountId === v.ownerAccountId ? 'owner+engager' : undefined,
  };
}

emmaToolRegistry.register({
  name: 'inspect_linkedin_account',
  definition: {
    name: 'inspect_linkedin_account',
    description:
      "List the user's connected LinkedIn Outreach accounts (no tokens) and, for a selected account, " +
      'its queued (not yet executed) social-engagement actions. Use before revoke_linkedin_account.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Optional LinkedIn Outreach account id to show queued actions for.' },
      },
      required: [],
    },
  },
  execute: async (args: { account_id?: string }, context: any) => {
    const userId = callerId(context);
    const reachable = (await getAccountsWithOwnerIncludingOrgShared(userId)).filter((a: any) => a?.platform === PLATFORM);
    const entry = (a: any) => ({
      accountId: a.account_id,
      name: a.account_name,
      sharedWithOrg: a.sharedWithOrg === true,
      connectedAt: a.connected_at ?? a.created_at,
      // ENG-3108: only a teammate's shared account carries these two fields.
      ...(a.userId !== userId && { sharedByTeammate: true, revocableByCaller: false }),
    });
    const listed = reachable.map(entry);
    if (!args?.account_id) return { accounts: listed };
    const selected = reachable.find((a: any) => a.account_id === args.account_id);
    if (!selected) {
      return { accounts: listed, error: `No LinkedIn Outreach account ${args.account_id} is connected to this user.` };
    }
    // A teammate's shared account: return its entry; its queued actions belong to its owner.
    if (selected.userId !== userId) return { accounts: listed, accountId: args.account_id, account: entry(selected) };
    const queued = await queuedActionsFor(userId, args.account_id);
    return { accounts: listed, accountId: args.account_id, queuedActions: queued.map(summarizeAction) };
  },
});

emmaToolRegistry.register({
  name: 'revoke_linkedin_account',
  definition: {
    name: 'revoke_linkedin_account',
    description:
      'Revoke (disconnect at the provider and remove) a LinkedIn Outreach account and pause all of its queued ' +
      'social-engagement actions. Irreversible for the connection. ONLY call after the user explicitly confirms ' +
      'the specific account; pass confirm=true. Returns the final state and any action that could not be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'LinkedIn Outreach account id (from inspect_linkedin_account).' },
        confirm: { type: 'boolean', description: 'Must be true, set only after the user explicitly confirmed.' },
      },
      required: ['account_id', 'confirm'],
    },
  },
  execute: async (args: { account_id?: string; confirm?: boolean }, context: any) => {
    const userId = callerId(context);
    const accountId = args?.account_id;
    if (!accountId) throw new Error('account_id is required');
    if (args.confirm !== true) {
      return { revoked: false, error: 'Explicit confirmation required: ask the user, then call again with confirm=true.' };
    }
    const before = await linkedInAccounts(userId);
    if (!before.some((a: any) => a.account_id === accountId)) {
      return { revoked: false, error: `No LinkedIn Outreach account ${accountId} is connected to this user.` };
    }
    const { canCallerDisconnectAccount } = await import('../routes/connectedAccounts');
    const guard = await canCallerDisconnectAccount(userId, PLATFORM, accountId);
    if (!guard.allowed) return { revoked: false, error: guard.error };

    // Neutralize queued actions first so nothing fires between revoke and cleanup.
    const queued = await queuedActionsFor(userId, accountId);
    const cancelled: string[] = [];
    const notCancelled: Array<{ scheduleId: string; error: string }> = [];
    for (const s of queued) {
      try {
        await scheduleDb.updateSchedule(s.scheduleId, { status: 'paused' });
        cancelled.push(s.scheduleId);
      } catch (err: any) {
        notCancelled.push({ scheduleId: s.scheduleId, error: err?.message || String(err) });
      }
    }

    let providerRevoked = true;
    let providerError: string | undefined;
    try {
      await linkedInOutreachService.deleteAccount(accountId);
    } catch (err: any) {
      providerRevoked = false;
      providerError = err?.message || String(err);
    }
    // Keep the local record when provider revocation fails so a retry can find it.
    let localError: string | undefined;
    if (providerRevoked) {
      try {
        await deleteAccountById(userId, PLATFORM as any, accountId);
      } catch (err: any) {
        localError = err?.message || String(err);
      }
    }

    const after = await linkedInAccounts(userId);
    const stillConnected = after.some((a: any) => a.account_id === accountId);
    const remaining = await queuedActionsFor(userId, accountId);
    for (const s of remaining) {
      if (!notCancelled.some((n) => n.scheduleId === s.scheduleId)) {
        notCancelled.push({ scheduleId: s.scheduleId, error: 'still active after cancel' });
      }
    }
    console.log(
      `[Audit][ENG-1153] revoke_linkedin_account user=${userId} account=${accountId} ` +
        `provider=${providerRevoked ? 'revoked' : 'failed'} cancelled=${cancelled.length} notCancelled=${notCancelled.length}`,
    );
    return {
      revoked: providerRevoked && !stillConnected,
      accountId,
      providerRevoked,
      ...(providerError && { providerError }),
      ...(localError && { localError }),
      removedFromAgentWeb: !stillConnected,
      cancelledActions: cancelled,
      notCancelled,
    };
  },
});
