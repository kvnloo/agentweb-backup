import axios from 'axios';
import { getGoogleAdsCredentials } from '../utils/secretsManager';
import { userDb } from './db';                          // sibling in services/
import { updateAccountTokens } from './connectedAccountsDb'; // sibling in services/

const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/v18';
const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdAccount {
  customerId: string;
  name: string;
  currency: string;
}

export interface GoogleAdsAccountCredentials {
  accessToken: string;
  customerId: string;
  currency: string;
}

export class GoogleAdsService {
  // Single-flight refresh guard: userId:accountId → in-flight promise
  private refreshInFlight = new Map<string, Promise<string>>();

  // ── Internal HTTP helper ─────────────────────────────────────────────────

  private async callApi(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: any
  ): Promise<any> {
    const secrets = await getGoogleAdsCredentials();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': secrets.developerToken,
      'login-customer-id': secrets.managerCustomerId,
      'Content-Type': 'application/json',
    };
    const response = method === 'GET'
      ? await axios.get(`${GOOGLE_ADS_API_BASE}${path}`, { headers })
      : await axios.post(`${GOOGLE_ADS_API_BASE}${path}`, body, { headers });
    return response.data;
  }

  async search(customerId: string, accessToken: string, query: string): Promise<any[]> {
    const data = await this.callApi('POST', `/customers/${customerId}/googleAds:search`, accessToken, { query });
    return data.results || [];
  }

  async mutate(customerId: string, accessToken: string, resource: string, operations: any[]): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/${resource}:mutate`, accessToken, { operations });
  }

  makeAuthError(message: string): Error {
    const err = new Error(message);
    (err as any).isGoogleAdsAuthError = true;
    return err;
  }

  // ── Token refresh (single-flight) ────────────────────────────────────────

  private async refreshAccessToken(userId: string, accountId: string, refreshToken: string): Promise<string> {
    const key = `${userId}:${accountId}`;
    if (this.refreshInFlight.has(key)) {
      return this.refreshInFlight.get(key)!;
    }
    const promise = (async () => {
      const secrets = await getGoogleAdsCredentials();
      const response = await axios.post(TOKEN_REFRESH_URL, new URLSearchParams({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const { access_token, expires_in } = response.data as { access_token: string; expires_in: number };
      await updateAccountTokens(userId, 'google_ads', {
        access_token,
        token_expires_at: Date.now() + expires_in * 1000,
      }, accountId);
      return access_token;
    })();
    this.refreshInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.refreshInFlight.delete(key);
    }
  }

  // ── Account credentials + ownership validation ───────────────────────────

  async getAccountCredentials(userId: string, customerId: string): Promise<GoogleAdsAccountCredentials> {
    const user = await userDb.getUserById(userId);
    if (!user) throw this.makeAuthError('User not found');

    const accounts: any[] = Array.isArray(user.connected_accounts)
      ? user.connected_accounts
      : user.connected_accounts ? [user.connected_accounts] : [];

    const account = accounts.find(
      (a: any) => a.platform === 'google_ads' && a.config?.customer_id === customerId
    );
    if (!account) throw this.makeAuthError('Google Ads account not found in your connected accounts. Connect it in Settings.');

    let accessToken = account.config.access_token;
    const isExpired = account.config.token_expires_at && Date.now() > account.config.token_expires_at - 60_000;
    if (isExpired && account.config.refresh_token) {
      accessToken = await this.refreshAccessToken(userId, account.account_id, account.config.refresh_token);
    }

    if (!accessToken) {
      throw this.makeAuthError('No access token available. Please reconnect your Google Ads account in Settings.');
    }

    return { accessToken, customerId, currency: account.config.currency || 'USD' };
  }

  // ── Account listing (used during OAuth finalize) ─────────────────────────

  async listAccessibleAccounts(accessToken: string): Promise<GoogleAdAccount[]> {
    const secrets = await getGoogleAdsCredentials();
    const response = await axios.get(`${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': secrets.developerToken,
      },
    });

    const resourceNames: string[] = (response.data as { resourceNames?: string[] }).resourceNames || [];
    if (resourceNames.length === 0) return [];

    const accounts: GoogleAdAccount[] = [];
    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const results = await this.search(customerId, accessToken,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1'
        );
        if (results.length > 0) {
          const c = results[0].customer;
          accounts.push({ customerId: String(c.id), name: c.descriptiveName || customerId, currency: c.currencyCode || 'USD' });
        }
      } catch {
        accounts.push({ customerId, name: customerId, currency: 'USD' });
      }
    }
    return accounts;
  }
}

export const googleAdsService = new GoogleAdsService();
