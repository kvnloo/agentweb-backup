import axios from 'axios';
import { getFathomConfig } from '../config/integrations';
import { getAccountsByUserId, updateAccountConfig } from './connectedAccountsDb';

/**
 * Shared Fathom OAuth token loader.
 *
 * Kept outside Emma tools so admin workflows and agent tools do not grow
 * separate token-refresh behavior.
 */
export async function getFathomAccessToken(userId: string): Promise<string | null> {
  const accounts = await getAccountsByUserId(userId);
  const fathomAccount = accounts.find((acc) => acc.platform === 'fathom');
  if (!fathomAccount) return null;

  const config = fathomAccount.config as any;

  if (config.refresh_token && config.token_expires_at && Date.now() > config.token_expires_at - 60000) {
    try {
      const fathomConfig = await getFathomConfig();
      const response = await axios.post(fathomConfig.tokenUrl, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refresh_token,
        client_id: fathomConfig.clientId,
        client_secret: fathomConfig.clientSecret,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const { access_token, refresh_token, expires_in } = response.data as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      await updateAccountConfig(userId, 'fathom', fathomAccount.account_id, {
        access_token,
        ...(refresh_token && { refresh_token }),
        token_expires_at: Date.now() + (expires_in * 1000),
      });

      return access_token;
    } catch (err: any) {
      console.error('[Fathom] Token refresh failed:', err?.message);
    }
  }

  return config.access_token || null;
}
