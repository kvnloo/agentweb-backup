import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAccountsByUserId, deleteAccount, deleteAccountById } from '../services/connectedAccountsDb';
import { getTokenStatus, formatExpiryMessage } from '../utils/tokenUtils';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

const router = express.Router();

// ============================================
// Connected Accounts Management
// ============================================

// List Connected Accounts (with status)
router.get('/connected-accounts', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accounts = await getAccountsByUserId(userId);

    const accountsWithStatus = accounts.map(acc => {
      // Accounts with a refresh token (e.g. Gmail) auto-renew — don't show the
      // short-lived access token expiry; just show them as permanently connected.
      const hasRefreshToken = !!(acc.config as any).refresh_token;
      const status = hasRefreshToken ? 'active' : getTokenStatus(acc.config.token_expires_at);
      const expiryMessage = hasRefreshToken ? 'Connected' : formatExpiryMessage(acc.config.token_expires_at);

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
        // Status fields
        status,
        expires_at: acc.config.token_expires_at,
        expiry_message: expiryMessage,
      };
    });

    res.json({ success: true, accounts: accountsWithStatus });
  } catch (error) {
    console.error('List Accounts Error:', error);
    res.status(500).json({ error: 'Failed to list connected accounts' });
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
