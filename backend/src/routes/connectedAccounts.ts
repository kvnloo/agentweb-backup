import express from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth';
import { getAccountsByUserId, getAccountsWithOwnerIncludingOrgShared, deleteAccount, deleteAccountById, getAccountByPlatform, getAccountById, updateAccountConfig, FathomConfig, CalendlyConfig } from '../services/connectedAccountsDb';
import { refreshCalendlyAccessToken } from './calendlyAuth';
import { registerProcessor, updateJobPayload } from '../services/asyncJobQueue';
import { CALENDLY_WEBHOOK_CLEANUP_SOURCE, CalendlyWebhookCleanupPayload, queueCalendlyWebhookCleanup } from '../services/calendlyWebhookCleanupQueue';
import { getTokenStatus, formatExpiryMessage } from '../utils/tokenUtils';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { FathomApiService } from '../services/fathomApiService';
import { getAllowedConnectedAccounts } from '../services/subscriptionService';
import { userDb, orgDb, crmDb } from '../services/db';

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

/**
 * Durable retry for a webhook subscription that couldn't be deleted inline during
 * disconnect (Calendly outage, or a token that a refresh at enqueue-time couldn't
 * fix but a LATER refresh might). Refreshes on every attempt rather than reusing
 * a stored access token, since by the time the poller retries this, whatever
 * token was current at enqueue-time is almost certainly stale again.
 */
export async function processCalendlyWebhookCleanupJob(payload: CalendlyWebhookCleanupPayload): Promise<void> {
  if (!payload.refreshToken) {
    throw new Error(`No refresh token available to clean up orphaned webhook ${payload.webhookId}`);
  }
  const refreshed = await refreshCalendlyAccessToken(payload.refreshToken);
  if (!refreshed) {
    throw new Error(`Could not refresh token to clean up orphaned webhook ${payload.webhookId}`);
  }
  // Greptile P1 on #2291 (round 20): Calendly may rotate the refresh token on
  // every use. If THIS refresh succeeded but the delete below then fails for an
  // unrelated reason (network blip), a later retry re-reads the ORIGINAL
  // enqueue-time payload — still carrying the now-invalid pre-rotation token —
  // and can never successfully refresh again. This job is registered with
  // maxAttempts: Infinity (round 9), so that isn't just a wasted attempt, it's
  // an infinite loop that can never make progress. Persist the possibly-rotated
  // refresh_token back to the durable row BEFORE attempting the delete, so any
  // later retry always starts from a token that was valid as of the last
  // successful refresh.
  if (refreshed.refresh_token && refreshed.refresh_token !== payload.refreshToken) {
    await updateJobPayload(CALENDLY_WEBHOOK_CLEANUP_SOURCE, payload.webhookId, { ...payload, refreshToken: refreshed.refresh_token });
  }
  await axios.delete(payload.webhookId, { headers: { Authorization: `Bearer ${refreshed.access_token}` } });
  console.log(`[Calendly] Cleaned up orphaned webhook ${payload.webhookId} via queued retry`);
}

// Greptile P1 on #2291 (round 9, issue 3): this job carries the ONLY remaining
// durable copy of a webhook_id once the local account record (its other copy)
// is deleted by disconnect. The default 5-attempt cap let it go terminally
// 'failed' and never be retried again — permanently stranding the orphaned
// Calendly-side subscription with no way left to recover its id and clean it
// up, which then blocks a later reconnect with Calendly's "Already Exists".
// Unlimited retries mean a Calendly outage or an initially-unrefreshable token
// still eventually resolves the orphan instead of going silently and
// permanently inert.
registerProcessor(CALENDLY_WEBHOOK_CLEANUP_SOURCE, processCalendlyWebhookCleanupJob, { maxAttempts: Infinity });

/**
 * Best-effort cleanup of the remote Calendly webhook subscription on disconnect,
 * symmetric with how /connect creates it. Non-fatal: disconnect must always
 * succeed locally even if this fails (expired token, Calendly outage, etc).
 *
 * Greptile P1 on #2291 (round 1): without this at all, disconnect deleted the
 * local account record (including webhook_id) but left the actual Calendly-side
 * subscription alive, permanently stranding a later reconnect.
 *
 * Greptile P1 on #2291 (round 4): the refresh-and-retry added for that fixed the
 * common "expired token" case, but disconnect still deleted the local account
 * (and its webhook_id) on ANY remaining failure — a revoked refresh token or a
 * Calendly outage at that exact moment — losing the only recorded identifier
 * forever with no way to ever clean it up. Enqueueing a durable retry job here,
 * BEFORE the account (and its webhook_id) is deleted, means that identifier
 * survives independently of the account's lifecycle: the queue's own poller
 * keeps retrying (refreshing the token fresh on each attempt) until it succeeds
 * or exhausts its attempts, at which point it's durably 'failed' in the queue
 * table rather than silently gone from everywhere.
 */
async function cleanupCalendlyWebhook(userId: string, account: { config: unknown } | null): Promise<void> {
  if (!account) return;
  const config = account.config as CalendlyConfig;
  if (!config.webhook_id || !config.access_token) return;

  const attemptDelete = (accessToken: string) =>
    axios.delete(config.webhook_id!, { headers: { Authorization: `Bearer ${accessToken}` } });

  try {
    await attemptDelete(config.access_token);
    console.log(`[Calendly] Deleted webhook ${config.webhook_id} on disconnect`);
    return;
  } catch (err: any) {
    const isAuthError = err?.response?.status === 401 || err?.response?.status === 403;
    if (!isAuthError || !config.refresh_token) {
      await queueCalendlyWebhookCleanup(userId, config);
      console.warn(`[Calendly] Failed to delete webhook ${config.webhook_id} on disconnect:`, err?.response?.data || err?.message);
      return;
    }
  }

  // The stored access token is short-lived and this cleanup often runs long after
  // last activity — an auth failure here is expected, not exceptional. Refresh once
  // and retry before falling back to the durable queue.
  const refreshed = await refreshCalendlyAccessToken(config.refresh_token!);
  if (!refreshed) {
    await queueCalendlyWebhookCleanup(userId, config);
    console.warn(`[Calendly] Could not refresh token to clean up webhook ${config.webhook_id} on disconnect — queued for retry`);
    return;
  }

  try {
    await attemptDelete(refreshed.access_token);
    console.log(`[Calendly] Deleted webhook ${config.webhook_id} on disconnect (after token refresh)`);
  } catch (retryErr: any) {
    // Greptile P1 on #2291 (round 20): the same rotation-loss bug as
    // processCalendlyWebhookCleanupJob, one call site earlier — refreshed
    // successfully refreshes the token above, but queuing the ORIGINAL
    // (pre-refresh) `config` here would enqueue the durable retry job with a
    // refresh_token Calendly may have already rotated and invalidated by this
    // very refresh call, guaranteeing that job's own first refresh attempt
    // fails too. refreshed.refresh_token is always the current valid one
    // (refreshCalendlyAccessToken falls back to the input token if Calendly
    // didn't rotate it) — use it, not the stale value still on `config`.
    await queueCalendlyWebhookCleanup(userId, { ...config, refresh_token: refreshed.refresh_token });
    console.warn(`[Calendly] Failed to delete webhook ${config.webhook_id} on disconnect even after token refresh:`, retryErr?.response?.data || retryErr?.message);
  }
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
      } else if (acc.platform === 'twitter' && (acc.config as any).needs_reconnect) {
        // Refresh token was revoked or permanently expired on X's side — the user
        // must re-authorise via OAuth. Treat as disconnected so the UI shows the
        // reconnect prompt instead of a misleading "Connected" badge.
        status = 'disconnected';
        expiryMessage = 'Reconnect required — X revoked the token';
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
        // Calendly only: false when the connecting account's plan doesn't support
        // webhooks (Free tier) — OAuth succeeded but no booking events will arrive (ENG-524).
        booking_tracking_active: acc.platform === 'calendly' ? ((acc.config as any).booking_tracking_active === true) : undefined,
        // Calendly only: which lead list bookings land in — explicitly chosen or
        // auto-resolved server-side on first booking (ENG-524 CRM-forward).
        booking_lead_list_id: acc.platform === 'calendly' ? (acc.config as any).booking_lead_list_id : undefined,
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

    if (platform === 'calendly') {
      // Greptile P1 on #2291: getAccountByPlatform only returns the FIRST matching
      // account, but a user can have more than one Calendly connection, and
      // deleteAccount below removes ALL of them — clean up every one, not just one,
      // or the rest are orphaned with no local record left to identify them.
      const allAccounts = await getAccountsByUserId(userId);
      const calendlyAccounts = allAccounts.filter((acc) => acc.platform === 'calendly');
      await Promise.all(calendlyAccounts.map((acc) => cleanupCalendlyWebhook(userId, acc)));
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

    if (platform === 'calendly') {
      await cleanupCalendlyWebhook(userId, await getAccountById(accountId, userId, 'calendly'));
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

// Choose which of the customer's own lead lists a Calendly booking gets created/updated
// in (CRM-forward, ENG-524). Ownership is checked explicitly — getLeadListById has no
// caller-scoping of its own, so a customer could otherwise point their bookings at a
// list they don't own.
router.patch('/connected-accounts/calendly/:accountId/booking-list', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { accountId } = req.params;
  const { listId } = req.body;

  if (typeof listId !== 'string' || !listId) {
    return res.status(400).json({ error: 'listId is required' });
  }

  try {
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ error: `No lead list with id "${listId}"` });
    }
    if (list.userId !== userId) {
      return res.status(403).json({ error: 'You do not own this lead list' });
    }

    await updateAccountConfig(userId, 'calendly', accountId, { booking_lead_list_id: listId });
    res.json({ success: true, accountId, booking_lead_list_id: listId });
  } catch (error: any) {
    // updateAccountConfig throws when the account isn't connected to this user
    if (typeof error?.message === 'string' && error.message.includes('No calendly account')) {
      return res.status(404).json({ error: error.message });
    }
    console.error('Update Calendly booking-list error:', error);
    res.status(500).json({ error: 'Failed to update Calendly booking list' });
  }
});

export default router;
