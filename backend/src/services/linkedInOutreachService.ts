import { UnipileClient } from 'unipile-node-sdk';
import { getUnipileCredentials } from '../utils/secretsManager';
import { userDb } from './db';

export class LinkedInOutreachService {
  private client: UnipileClient | null = null;
  // Cached to avoid a Secrets Manager round-trip on every method call
  private cachedDsn: string | null = null;
  private cachedApiKey: string | null = null;

  // ─── Logging helpers ────────────────────────────────────────────────────────

  private log(message: string, data?: any) {
    console.log(`[LinkedInOutreachService] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  private handleError(error: any, context: string): never {
    console.error(`[LinkedInOutreachError] --- START ERROR LOG ---`);
    console.error(`[LinkedInOutreachError] Context: ${context}`);

    // Unipile's UnsuccessfulRequestError uses error.body; fall back through all formats
    const responseData = error.response?.data || error.response || error.body || {};

    const structuredError: any = {
      message: responseData.message || responseData.title || responseData.detail || error.message || 'Unknown error',
      code: responseData.code || responseData.type || error.code,
      status: error.response?.status || responseData.status || error.status,
      details: responseData.details || responseData.detail || error.details,
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

    // Unipile SDK errors have error.body but use the class name as message (e.g. "UnsuccessfulRequestError").
    // Replace with the human-readable structured message so callers receive something actionable.
    const enhancedError = (error instanceof Error && (error as any).body)
      ? new Error(structuredError.message)
      : (error instanceof Error ? error : new Error(structuredError.message));
    (enhancedError as any).structuredError = structuredError;
    throw enhancedError;
  }

  // ─── Client initialization ───────────────────────────────────────────────────

  /**
   * Fetch credentials once and cache them for the lifetime of this instance.
   */
  private async getCredentials(): Promise<{ dsn: string; apiKey: string }> {
    if (!this.cachedDsn || !this.cachedApiKey) {
      const creds = await getUnipileCredentials();
      const rawDsn = creds.dsn;
      this.cachedDsn = rawDsn.startsWith('http://') || rawDsn.startsWith('https://')
        ? rawDsn
        : `https://${rawDsn}`;
      this.cachedApiKey = creds.apiKey;
    }
    return { dsn: this.cachedDsn!, apiKey: this.cachedApiKey! };
  }

  /**
   * Get the normalized API URL (DSN) from cached credentials.
   */
  async getApiUrl(): Promise<string> {
    const { dsn } = await this.getCredentials();
    return dsn;
  }

  /**
   * Get an initialized UnipileClient instance, reusing the cached client
   * to avoid repeated Secrets Manager calls.
   */
  async getClient(): Promise<UnipileClient> {
    if (this.client) return this.client;
    const { dsn, apiKey } = await this.getCredentials();
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
   * Resolve the target to a Unipile provider_id.
   * @param target  - Either a LinkedIn profile URL or a raw provider_id string.
   * @param isUrl   - true if target is a profile URL; false if it is already a provider_id.
   * @param account_id - Required when isUrl is true.
   */
  private async resolveProviderId(target: string, isUrl: boolean, account_id: string): Promise<string> {
    if (isUrl) {
      this.log(`Resolving LinkedIn URL to provider_id`, { target, account_id });
      const profile = await this.getLinkedInProfile(target, account_id);
      const resolved = profile?.provider_id;
      if (!resolved) {
        throw new Error(`Could not resolve provider_id from URL: ${target}`);
      }
      this.log(`Resolved provider_id: ${resolved}`);
      return resolved;
    }
    return target;
  }

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
   * @param account_id     - The Unipile account ID to send from.
   * @param profileUrlOrId - A LinkedIn profile URL OR a raw provider_id.
   * @param isUrl          - true if profileUrlOrId is a profile URL, false if it is already a provider_id.
   * @param message        - Optional personalised note to attach to the invitation.
   */
  async sendInvitation(account_id: string, profileUrlOrId: string, isUrl: boolean, message?: string): Promise<any> {
    try {
      const provider_id = await this.resolveProviderId(profileUrlOrId, isUrl, account_id);
      await this.checkIsNotAlreadyConnected(account_id, provider_id);
      this.log(`Sending invitation`, { account_id, provider_id });
      const client = await this.getClient();
      const res = await client.users.sendInvitation({
        account_id,
        provider_id,
        message
      });
      this.log(`Invitation sent successfully`, { account_id, provider_id });
      return res;
    } catch (error: any) {
      return this.handleError(error, 'sendInvitation');
    }
  }

  /**
   * Check that a target profile is not already a 1st-degree connection before sending an invite.
   */
  private async checkIsNotAlreadyConnected(accountId: string, providerId: string): Promise<void> {
    const client = await this.getClient();
    const profile = await client.users.getProfile({
      account_id: accountId,
      identifier: providerId
    });
    const distance = (profile as any).network_distance;

    if (distance === 'FIRST_DEGREE') {
      throw new Error(
        `Cannot send invite: you are already connected with this person. ` +
        `Use the send-message action to reach them directly.`
      );
    }
  }

  /**
   * Check that a target profile can receive DMs: must be a 1st-degree connection
   * or have an open profile (LinkedIn Premium Open Profile).
   */
  private async checkIsMessageable(accountId: string, providerId: string): Promise<void> {
    const client = await this.getClient();
    const profile = await client.users.getProfile({
      account_id: accountId,
      identifier: providerId
    });
    const distance = (profile as any).network_distance;
    const isOpenProfile = (profile as any).is_open_profile;

    if (distance !== 'FIRST_DEGREE' && !isOpenProfile) {
      throw new Error(
        `Cannot send message: target is not a 1st-degree connection (status: ${distance ?? 'unknown'}). ` +
        `Use the send-invite action first to connect.`
      );
    }
  }

  /**
   * Send a message to a LinkedIn profile.
   * Uses startNewChat to handle both new and existing conversations.
   * @param accountId      - The Unipile account ID to send from.
   * @param profileUrlOrId - A LinkedIn profile URL OR a raw provider_id.
   * @param isUrl          - true if profileUrlOrId is a profile URL, false if it is already a provider_id.
   * @param messageText    - The message to send.
   */
  async sendMessage(accountId: string, profileUrlOrId: string, isUrl: boolean, messageText: string): Promise<any> {
    try {
      const providerId = await this.resolveProviderId(profileUrlOrId, isUrl, accountId);
      await this.checkIsMessageable(accountId, providerId);
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
      if (error.body?.type === 'errors/no_connection_with_recipient') {
        throw new Error(
          `Cannot send message: target is not a 1st-degree connection. ` +
          `Use the send-invite action first to connect.`
        );
      }
      return this.handleError(error, 'sendMessage');
    }
  }
}

export const linkedInOutreachService = new LinkedInOutreachService();
