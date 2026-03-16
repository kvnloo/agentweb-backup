import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAccountsByUserId, deleteAccount, deleteAccountById, createAccount, getAccountByPlatform, updateAccountConfig, FathomConfig } from '../services/connectedAccountsDb';
import { getTokenStatus, formatExpiryMessage } from '../utils/tokenUtils';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { FathomApiService } from '../services/fathomApiService';

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

// ============================================
// Fathom — API Key connection (not OAuth)
// ============================================

// Connect Fathom account via API key
router.post('/connected-accounts/fathom', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { api_key } = req.body;

  if (!api_key || typeof api_key !== 'string') {
    return res.status(400).json({ error: 'api_key is required' });
  }

  // Validate the API key against Fathom's API
  try {
    const validationResponse = await fetch('https://api.fathom.ai/external/v1/teams', {
      method: 'GET',
      headers: {
        'X-Api-Key': api_key,
        'Content-Type': 'application/json',
      },
    });

    if (!validationResponse.ok) {
      if (validationResponse.status === 401 || validationResponse.status === 403) {
        return res.status(401).json({ error: 'Invalid Fathom API key' });
      }
      return res.status(502).json({ error: `Fathom API returned status ${validationResponse.status}` });
    }
  } catch (fetchErr: any) {
    console.error('[Fathom] API validation failed:', fetchErr?.message);
    return res.status(502).json({ error: 'Unable to reach Fathom API to validate key' });
  }

  try {
    const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
    const fathomConfig: FathomConfig = {
      account_type: 'api_key',
      api_key,
      access_token: api_key, // For BaseOAuthConfig compat
      token_expires_at: Date.now() + TEN_YEARS_MS,
    };

    const accountId = `fathom-${userId}`;
    const account = await createAccount(userId, 'fathom', {
      account_id: accountId,
      account_name: 'Fathom',
      config: fathomConfig,
    });

    // Register webhook with Fathom so meetings flow in automatically.
    // This is best-effort — if it fails, the account is still connected
    // and the user can retry or we can register later.
    try {
      const fathomApi = new FathomApiService(api_key);
      const baseUrl = process.env.API_BASE_URL || 'https://api.agentweb.pro';
      const webhookUrl = `${baseUrl}/api/webhooks/fathom`;
      const { id: webhookId } = await fathomApi.registerWebhook(webhookUrl);

      // Store webhook_id so we can clean it up on disconnect
      await updateAccountConfig(userId, 'fathom', accountId, {
        webhook_id: webhookId,
        webhook_url: webhookUrl,
      });
      console.log(`[Fathom] Registered webhook ${webhookId} for user ${userId}`);
    } catch (webhookErr: any) {
      // Non-fatal: account is saved, webhook can be registered later
      console.warn(`[Fathom] Webhook registration failed for user ${userId}:`, webhookErr?.message);
    }

    res.json({ success: true, account });
  } catch (error) {
    console.error('[Fathom] Connect error:', error);
    res.status(500).json({ error: 'Failed to connect Fathom account' });
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
      if (config.webhook_id && config.api_key) {
        try {
          const fathomApi = new FathomApiService(config.api_key);
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
