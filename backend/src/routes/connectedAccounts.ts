import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAccountsByUserId, getAccountsWithOwnerIncludingOrgShared, deleteAccount, deleteAccountById, getAccountByPlatform, updateAccountConfig, FathomConfig } from '../services/connectedAccountsDb';
import { getTokenStatus, formatExpiryMessage } from '../utils/tokenUtils';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { FathomApiService } from '../services/fathomApiService';
import { getAllowedConnectedAccounts } from '../services/subscriptionService';
import { userDb, orgDb } from '../services/db';

const router = express.Router();

async function canCallerDisconnectAccount(userId: string, platform: string, accountId?: string): Promise<{ allowed: boolean; error?: string }> {
  const user = await userDb.getUserById(userId);
  if (!user?.orgId) {
    return { allowed: true };
  }

  const matchingAccounts = (user.connected_accounts || []).filter((account: any) => {
    if (account.platform !== platform) return false;
    return accountId ? account.account_id === accountId : true;
  });

  const hasOrgSharedAccount = matchingAccounts.some((account: any) => account.sharedWithOrg === true);
  if (!hasOrgSharedAccount) {
    return { allowed: true };
  }

  const org = await orgDb.getOrgById(user.orgId);
  const isOrgOwner = org?.ownerUserId === userId || user.orgRole === 'owner';
  if (isOrgOwner) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: 'Only the org owner can disconnect an org-shared connected account. Unshare it from the organization first.',
  };
}

// ============================================
// Connected Accounts Management
// ============================================

// List Connected Accounts (with status)
router.get('/connected-accounts', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    // Owner-aware variant: each account carries the userId of the member who owns
    // it, so we can tell the frontend which rows the caller owns (own rows get the
    // Share/Disconnect controls; teammates' org-shared rows are read-only).
    const accounts = await getAccountsWithOwnerIncludingOrgShared(userId);

    // Check real connection status for Unipile accounts in a single paginated call
    const unipileAccountIds = accounts
      .filter(acc => acc.platform === 'unipile')
      .map(acc => acc.account_id);
    const unipileStatusMap = await linkedInOutreachService.getStatusesForAccounts(unipileAccountIds);

    // Pre-validate Fathom tokens with a live API call (token_expires_at is unreliable
    // because Fathom may revoke tokens server-side without updating the stored expiry).
    const fathomAccounts = accounts.filter(acc => acc.platform === 'fathom');
    const fathomLiveStatusMap = new Map<string, boolean | null>();
    await Promise.all(fathomAccounts.map(async acc => {
      try {
        const fathomApi = new FathomApiService((acc.config as any).access_token);
        fathomLiveStatusMap.set(acc.account_id, await fathomApi.validateApiKey());
      } catch {
        fathomLiveStatusMap.set(acc.account_id, null);
      }
    }));

    const accountsWithStatus = accounts.map(acc => {
      let status: string;
      let expiryMessage: string;

      if (acc.platform === 'unipile') {
        // Unipile manages credentials; use the real status from their API
        const unipileStatus = unipileStatusMap.get(acc.account_id) || 'OK';
        status = unipileStatus === 'OK' ? 'active' : 'disconnected';
        expiryMessage = unipileStatus === 'OK' ? 'Connected' : `Disconnected (${unipileStatus})`;
      } else if (acc.platform === 'fathom') {
        // Fathom: use live API check — token_expires_at is unreliable (server-side revocation).
        // null means the check was inconclusive (network error, timeout, 5xx) — treat as active
        // to avoid falsely showing "Disconnected" on transient Fathom API failures.
        const liveStatus = fathomLiveStatusMap.get(acc.account_id) ?? null;
        const isDisconnected = liveStatus === false;
        status = isDisconnected ? 'disconnected' : 'active';
        expiryMessage = isDisconnected ? 'Disconnected — please reconnect' : 'Connected';
      } else {
        // Accounts with a refresh token (e.g. Gmail) auto-renew — don't show the
        // short-lived access token expiry; just show them as permanently connected.
        const hasRefreshToken = !!(acc.config as any).refresh_token;
        status = hasRefreshToken ? 'active' : getTokenStatus(acc.config.token_expires_at);
        expiryMessage = hasRefreshToken ? 'Connected' : formatExpiryMessage(acc.config.token_expires_at);
      }

      // Gmail stores picture as picture_url; other platforms use profile_image_url
      const profileImageUrl =
        (acc.config as any).picture_url ||
        (acc.config as any).profile_image_url;

      return {
        platform: acc.platform,
        account_id: acc.account_id,
        account_name: acc.account_name,
        account_type: acc.config.account_type,
        profile_id: (acc.config as any).profile_id,
        page_id: (acc.config as any).page_id,
        profile_image_url: profileImageUrl,
        account_handle: (acc.config as any).account_handle,
        follower_count: (acc.config as any).follower_count,
        created_at: acc.created_at,
        sharedWithOrg: (acc as any).sharedWithOrg ?? false,
        // True when the caller owns this account; false when it's a teammate's
        // account shared with the org. The frontend uses this to show owner-only
        // controls (Share/Stop sharing/Disconnect) on owned rows only.
        owned: acc.userId === userId,
        // LinkedIn Outreach (unipile) only: Premium accounts allow 300-char invites.
        is_premium: acc.platform === 'unipile' ? ((acc.config as any).is_premium === true) : undefined,
        // Status fields
        status,
        expires_at: acc.config.token_expires_at,
        expiry_message: expiryMessage,
      };
    });

    // Include allowed platforms so frontend can show/hide platform cards
    const allowedConnectedAccounts = await getAllowedConnectedAccounts(userId);

    res.json({ success: true, accounts: accountsWithStatus, allowedConnectedAccounts });
  } catch (error) {
    console.error('List Accounts Error:', error);
    res.status(500).json({ error: 'Failed to list connected accounts' });
  }
});

// Disconnect Fathom — with webhook cleanup via FathomApiService
router.delete('/connected-accounts/fathom', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    // Check for existing webhook to clean up
    const existingAccount = await getAccountByPlatform(userId, 'fathom');
    if (existingAccount) {
      const config = existingAccount.config as FathomConfig;
      if (config.webhook_id && config.access_token) {
        try {
          const fathomApi = new FathomApiService(config.access_token);
          await fathomApi.deleteWebhook(config.webhook_id);
          console.log(`[Fathom] Deleted webhook ${config.webhook_id} for user ${userId}`);
        } catch (webhookErr: any) {
          // Non-fatal: log and continue with DB deletion
          console.warn(`[Fathom] Failed to delete webhook ${config.webhook_id}:`, webhookErr?.message);
        }
      }
    }

    await deleteAccount(userId, 'fathom');
    res.json({ success: true, message: 'Fathom account disconnected' });
  } catch (error) {
    console.error('[Fathom] Disconnect error:', error);
    res.status(500).json({ error: 'Failed to disconnect Fathom account' });
  }
});

// Delete Connected Account by platform (all accounts for that platform)
router.delete('/connected-accounts/:platform', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { platform } = req.params;

  try {
    const disconnectGuard = await canCallerDisconnectAccount(userId, platform);
    if (!disconnectGuard.allowed) {
      return res.status(403).json({ error: disconnectGuard.error });
    }

    await deleteAccount(userId, platform);
    res.json({ success: true, message: `${platform} account(s) disconnected` });
  } catch (error) {
    console.error('Delete Account Error:', error);
    res.status(500).json({ error: 'Failed to delete connected account' });
  }
});

// Delete specific Connected Account by platform and account_id
router.delete('/connected-accounts/:platform/:accountId', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { platform, accountId } = req.params;

  try {
    const disconnectGuard = await canCallerDisconnectAccount(userId, platform, accountId);
    if (!disconnectGuard.allowed) {
      return res.status(403).json({ error: disconnectGuard.error });
    }

    // For LinkedIn Outreach accounts, also delete from Unipile so the
    // connection is fully revoked — not just removed from our DB.
    if (platform === 'unipile') {
      try {
        await linkedInOutreachService.deleteAccount(accountId);
        console.log(`[LinkedIn Outreach] Deleted Unipile account ${accountId} for user ${userId}`);
      } catch (unipileErr: any) {
        // Non-fatal: log and continue with DB deletion so the user isn't stuck
        console.warn(`[LinkedIn Outreach] Failed to delete Unipile account ${accountId}:`, unipileErr?.message);
      }
    }

    await deleteAccountById(userId, platform, accountId);
    res.json({ success: true, message: `${platform} account ${accountId} disconnected` });
  } catch (error) {
    console.error('Delete Account By ID Error:', error);
    res.status(500).json({ error: 'Failed to delete connected account' });
  }
});

// Mark a LinkedIn Outreach (unipile) account as Premium / free. Premium accounts
// allow 300-char invitation notes; free accounts are limited to 200.
router.patch('/connected-accounts/unipile/:accountId/premium', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { accountId } = req.params;
  const { isPremium } = req.body;

  if (typeof isPremium !== 'boolean') {
    return res.status(400).json({ error: 'isPremium must be a boolean' });
  }

  try {
    await updateAccountConfig(userId, 'unipile', accountId, { is_premium: isPremium });
    res.json({ success: true, accountId, is_premium: isPremium });
  } catch (error: any) {
    // updateAccountConfig throws when the account isn't connected to this user
    if (typeof error?.message === 'string' && error.message.includes('No unipile account')) {
      return res.status(404).json({ error: error.message });
    }
    console.error('Update LinkedIn Premium flag error:', error);
    res.status(500).json({ error: 'Failed to update LinkedIn Premium status' });
  }
});

export default router;
