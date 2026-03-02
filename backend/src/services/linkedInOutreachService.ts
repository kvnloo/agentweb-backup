import { UnipileClient } from 'unipile-node-sdk';
import { getUnipileCredentials } from '../utils/secretsManager';
import { userDb } from './db';

export class LinkedInOutreachService {
  private client: UnipileClient | null = null;

  // ─── Logging helpers ────────────────────────────────────────────────────────

  private log(message: string, data?: any) {
    console.log(`[LinkedInOutreachService] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  private handleError(error: any, context: string): never {
    console.error(`[LinkedInOutreachError] --- START ERROR LOG ---`);
    console.error(`[LinkedInOutreachError] Context: ${context}`);

    const responseData = error.response?.data || error.response || {};

    const structuredError: any = {
      message: responseData.message || error.message || 'Unknown error',
      code: responseData.code || error.code,
      status: error.response?.status || error.status,
      details: responseData.details || error.details,
      classification: 'UNKNOWN_ERROR'
    };

    // Basic classification based on HTTP status or error code
    const status = Number(structuredError.status);
    if (status === 401 || status === 403) {
      structuredError.classification = 'AUTH_ERROR';
    } else if (status === 404) {
      structuredError.classification = 'NOT_FOUND';
    } else if (status === 429) {
      structuredError.classification = 'RATE_LIMIT_ERROR';
    } else if (status >= 500) {
      structuredError.classification = 'SERVER_ERROR';
    } else if (status >= 400) {
      structuredError.classification = 'VALIDATION_ERROR';
    }

    console.error(`[LinkedInOutreachError] Structured Data:`, JSON.stringify(structuredError, null, 2));
    console.error(`[LinkedInOutreachError] --- END ERROR LOG ---`);

    const enhancedError = error instanceof Error ? error : new Error(structuredError.message);
    (enhancedError as any).structuredError = structuredError;
    throw enhancedError;
  }

  // ─── Client initialization ───────────────────────────────────────────────────

  /**
   * Get the normalized API URL (DSN) from credentials.
   */
  async getApiUrl(): Promise<string> {
    const { dsn: rawDsn } = await getUnipileCredentials();
    return rawDsn.startsWith('http://') || rawDsn.startsWith('https://')
      ? rawDsn
      : `https://${rawDsn}`;
  }

  /**
   * Get an initialized UnipileClient instance.
   * Credentials are fetched from Secrets Manager.
   */
  async getClient(): Promise<UnipileClient> {
    const { apiKey } = await getUnipileCredentials();
    const dsn = await this.getApiUrl();
    this.client = new UnipileClient(dsn, apiKey);
    return this.client;
  }

  // ─── Account management ──────────────────────────────────────────────────────

  /**
   * Delete an account from Unipile.
   * @param accountId - The Unipile account ID to delete.
   */
  async deleteAccount(accountId: string): Promise<void> {
    try {
      this.log(`Deleting account: ${accountId}`);
      const client = await this.getClient();
      await client.account.delete(accountId);
      this.log(`Successfully deleted account: ${accountId}`);
    } catch (error: any) {
      return this.handleError(error, 'deleteAccount');
    }
  }

  /**
   * Fetch one account from Unipile.
   * @param accountId - The Unipile account ID to fetch.
   */
  async getAccount(accountId: string) {
    try {
      this.log(`Fetching account: ${accountId}`);
      const client = await this.getClient();
      return await client.account.getOne(accountId);
    } catch (error: any) {
      return this.handleError(error, 'getAccount');
    }
  }

  /**
   * List all connected LinkedIn accounts for a specific user.
   * Fetches all pages from Unipile to ensure no accounts are missed,
   * then intersects with the user's connected accounts in the DB.
   */
  async listAccounts(userId: string): Promise<any> {
    try {
      this.log(`Listing accounts for user: ${userId}`);

      // 1. Get user from DB to see their authorized Unipile accounts
      const user = await userDb.getUserById(userId);
      if (!user) throw new Error('User not found');

      // 2. Extract Unipile account IDs from user's connected_accounts in DB
      //    (platform === 'unipile' accounts store the Unipile internal ID as account_id)
      const userUnipileAccountIds = (user.connected_accounts || [])
        .filter((acc: any) => acc.platform === 'unipile')
        .map((acc: any) => acc.account_id);

      if (userUnipileAccountIds.length === 0) {
        this.log(`No Unipile accounts connected in DB for user: ${userId}`);
        return { object: 'AccountList', items: [], message: 'No LinkedIn Outreach accounts connected for this user' };
      }

      // 3. Get ALL accounts from Unipile (handling pagination)
      const client = await this.getClient();
      const allUnipileItems: any[] = [];
      let cursor: string | undefined = undefined;

      do {
        const res: any = await client.account.getAll(cursor ? { cursor } : undefined);
        if (res && res.items) {
          allUnipileItems.push(...res.items);
        }
        cursor = res.cursor || undefined;
      } while (cursor);

      this.log(`Fetched ${allUnipileItems.length} total accounts from Unipile`);

      // 4. Perform intersection: Only return Unipile accounts the user has actually connected
      //    item.id (Unipile internal ID) matches the account_id stored in DB during save-account
      const filteredItems = allUnipileItems.filter((item: any) =>
        item.type === 'LINKEDIN' && userUnipileAccountIds.includes(item.id)
      );

      this.log(`Returning ${filteredItems.length} matched LinkedIn accounts for user: ${userId}`);

      return {
        object: 'AccountList',
        items: filteredItems,
        total: filteredItems.length
      };
    } catch (e: any) {
      return this.handleError(e, 'listAccounts');
    }
  }

  // ─── Profile & outreach ──────────────────────────────────────────────────────

  /**
   * Get LinkedIn profile by URL/identifier.
   */
  async getLinkedInProfile(profileUrl: string, account_id: string): Promise<any> {
    // Extract identifier from URL (expected format: .../in/identifier/)
    let identifier = profileUrl.trim();
    if (identifier.endsWith('/')) {
      identifier = identifier.substring(0, identifier.length - 1);
    }
    const parts = identifier.split('/in/');
    if (parts.length < 2) {
      throw new Error('Invalid LinkedIn profile URL. Must contain /in/{identifier}');
    }
    identifier = parts[parts.length - 1];

    try {
      this.log(`Fetching LinkedIn profile: ${identifier}`, { account_id });
      const client = await this.getClient();
      // Use raw request to call /users/{identifier}
      const profile = await client.request.send({
        method: 'GET',
        path: ['users', identifier],
        parameters: { account_id }
      });
      this.log(`Successfully fetched profile: ${identifier}`);
      return profile;
    } catch (error: any) {
      return this.handleError(error, 'getLinkedInProfile');
    }
  }

  /**
   * Send a connection invitation on LinkedIn.
   */
  async sendInvitation(account_id: string, profile_id: string, message?: string): Promise<any> {
    try {
      this.log(`Sending invitation`, { account_id, profile_id });
      const client = await this.getClient();
      const res = await client.users.sendInvitation({
        account_id,
        provider_id: profile_id,
        message: message || "Hello, I'm interested in connecting with you."
      });
      this.log(`Invitation sent successfully`, { account_id, profile_id });
      return res;
    } catch (error: any) {
      return this.handleError(error, 'sendInvitation');
    }
  }

  /**
   * Send a message to a LinkedIn profile.
   * Uses startNewChat to handle both new and existing conversations.
   */
  async sendMessage(accountId: string, providerId: string, messageText: string): Promise<any> {
    try {
      this.log(`Sending message`, { accountId, providerId, messageLength: messageText.length });
      const client = await this.getClient();
      const res = await client.messaging.startNewChat({
        account_id: accountId,
        attendees_ids: [providerId],
        text: messageText
      });
      this.log(`Message sent successfully`, { accountId, providerId });
      return res;
    } catch (error: any) {
      return this.handleError(error, 'sendMessage');
    }
  }
}

export const linkedInOutreachService = new LinkedInOutreachService();
