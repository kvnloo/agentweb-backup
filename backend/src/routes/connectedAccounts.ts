import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAccountsByUserId, deleteAccount, deleteAccountById, getAccountByPlatform, FathomConfig } from '../services/connectedAccountsDb';
import { getTokenStatus, formatExpiryMessage } from '../utils/tokenUtils';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { FathomApiService } from '../services/fathomApiService';
import { getAllowedConnectedAccounts } from '../services/subscriptionService';

const router = express.Router();

// ============================================
// Connected Accounts Management
// ============================================

// List Connected Accounts (with status)
router.get('/connected-accounts', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accounts = await getAccountsByUserId(userId);

    // Check real connection status for Unipile accounts in a single paginated call
    const unipileAccountIds = accounts
      .filter(acc => acc.platform === 'unipile')
      .map(acc => acc.account_id);
    const unipileStatusMap = await linkedInOutreachService.getStatusesForAccounts(unipileAccountIds);

    // Pre-validate Fathom tokens with a live API call (token_expires_at is unreliable
    // because Fathom may revoke tokens server-side without updating the stored expiry).
    const fathomAccounts = accounts.filter(acc => acc.platform === 'fathom');
    const fathomLiveStatusMap = new Map<string, boolean>();
    await Promise.all(fathomAccounts.map(async acc => {
      try {
        const fathomApi = new FathomApiService((acc.config as any).access_token);
        fathomLiveStatusMap.set(acc.account_id, await fathomApi.validateApiKey());
      } catch {
        fathomLiveStatusMap.set(acc.account_id, false);
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
        // Fathom: use live API check — token_expires_at is unreliable (server-side revocation)
        const isLive = fathomLiveStatusMap.get(acc.account_id) ?? false;
        status = isLive ? 'active' : 'disconnected';
        expiryMessage = isLive ? 'Connected' : 'Disconnected — please reconnect';
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

export default router;
