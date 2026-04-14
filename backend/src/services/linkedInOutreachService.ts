import { UnipileClient } from 'unipile-node-sdk';
import { getUnipileCredentials } from '../utils/secretsManager';
import { userDb } from './db';

// NOTE: Unipile actively maintains: Emails, WhatsApp, LinkedIn, Telegram, Instagram (as of March 2026).
// Twitter/X support is suspended — see dev.md for details.

export class LinkedInOutreachService {
  private client: UnipileClient | null = null;
  // Cached to avoid a Secrets Manager round-trip on every method call
  private cachedDsn: string | null = null;
  private cachedApiKey: string | null = null;
  // Short-lived cache for connectivity checks — avoids a Unipile API call on every page load
  private connectedStatusCache: Map<string, { connected: boolean; timestamp: number }> = new Map();
  private static readonly CONNECTED_STATUS_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
   * Fetch live connectivity status for a set of Unipile account IDs.
   * Returns a map of account_id → "OK" (connected) or "ERROR" (disconnected/not found).
   * Uses a self-profile lookup per account to verify the LinkedIn session is active,
   * since account.getAll() does not expose a usable session status field.
   */
  async getStatusesForAccounts(accountIds: string[]): Promise<Map<string, string>> {
    const statusMap = new Map<string, string>(accountIds.map(id => [id, 'ERROR']));
    if (accountIds.length === 0) return statusMap;

    await Promise.all(accountIds.map(async (id) => {
      const connected = await this.isAccountConnected(id);
      statusMap.set(id, connected ? 'OK' : 'ERROR');
    }));

    return statusMap;
  }

  /**
   * Check whether a single Unipile account is still connected.
   * Used by resolveAccountId (sequential fallback) and admin status endpoints.
   * Returns true if connected, false if disconnected or any error occurs.
   * Results are cached for 10 minutes to avoid redundant per-request API calls.
   */
  async isAccountConnected(accountId: string): Promise<boolean> {
    const cached = this.connectedStatusCache.get(accountId);
    if (cached && Date.now() - cached.timestamp < LinkedInOutreachService.CONNECTED_STATUS_TTL_MS) {
      return cached.connected;
    }
    let connected: boolean;
    try {
      const client = await this.getClient();
      // account.getOne() returns account metadata but no session status field.
      // Use the account's own LinkedIn publicIdentifier for a self-profile lookup —
      // this fails with 401 if the LinkedIn session is disconnected.
      const account = await client.account.getOne(accountId) as any;
      const publicIdentifier = account?.connection_params?.im?.publicIdentifier;
      if (!publicIdentifier) {
        this.log(`Account ${accountId} has no publicIdentifier — assuming connected`);
        connected = true;
      } else {
        await client.request.send({
          method: 'GET',
          path: ['users', publicIdentifier],
          parameters: { account_id: accountId },
        });
        connected = true;
      }
    } catch (error: any) {
      const code = error?.body?.code || error?.code || '';
      const status = error?.body?.status || error?.status;
      this.log(`Account ${accountId} connectivity check failed (${status} ${code})`);
      connected = false;
    }
    this.connectedStatusCache.set(accountId, { connected, timestamp: Date.now() });
    return connected;
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
  async resolveProviderId(target: string, isUrl: boolean, account_id: string): Promise<string> {
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
   * Uses raw API call to avoid SDK validator failures.
   */
  private async checkIsNotAlreadyConnected(accountId: string, providerId: string): Promise<void> {
    try {
      const client = await this.getClient();
      this.log(`Fetching profile for connection check`, { accountId, providerId });
      const profile = await client.request.send({
        method: 'GET',
        path: ['users', providerId],
        parameters: { account_id: accountId }
      }) as any;
      const distance = profile?.network_distance;
      this.log(`Connection check for invite`, { providerId, network_distance: distance });

      // Unipile may return 'FIRST_DEGREE' (validated format) or 'DISTANCE_1' (raw format)
      if (distance === 'FIRST_DEGREE' || distance === 'DISTANCE_1') {
        throw new Error(
          `Cannot send invite: you are already connected with this person (network_distance: ${distance}). ` +
          `Use the send-message action to reach them directly.`
        );
      }
    } catch (error: any) {
      if (error.message?.startsWith('Cannot send invite:')) throw error;
      // Profile lookup failed — log and proceed rather than blocking the invite
      this.log(`Connection status check skipped (profile fetch failed)`, { providerId, reason: error.message });
    }
  }

  /**
   * Check that a target profile can receive DMs: must be a 1st-degree connection
   * or have an open profile (LinkedIn Premium Open Profile).
   * Uses raw API call to avoid SDK validator failures.
   */
  private async checkIsMessageable(accountId: string, providerId: string): Promise<void> {
    try {
      const client = await this.getClient();
      this.log(`Fetching profile for messageability check`, { accountId, providerId });
      const profile = await client.request.send({
        method: 'GET',
        path: ['users', providerId],
        parameters: { account_id: accountId }
      }) as any;
      const distance = profile?.network_distance;
      const isOpenProfile = profile?.is_open_profile;
      this.log(`Messageability check`, { providerId, network_distance: distance, is_open_profile: isOpenProfile });

      // Unipile may return 'FIRST_DEGREE' (validated format) or 'DISTANCE_1' (raw format)
      const isFirstDegree = distance === 'FIRST_DEGREE' || distance === 'DISTANCE_1';
      if (!isFirstDegree && !isOpenProfile) {
        throw new Error(
          `Cannot send message: target is not a 1st-degree connection (status: ${distance ?? 'unknown'}). ` +
          `Use the send-invite action first to connect.`
        );
      }
    } catch (error: any) {
      // Re-throw our own check errors
      if (error.message?.startsWith('Cannot send message:')) throw error;
      // For API/network errors, log a warning but let the message attempt proceed
      // (Unipile API will reject it server-side if not messageable)
      this.log(`Messageability check skipped (profile fetch failed)`, { providerId, reason: error.message });
    }
  }

  // ─── Search & discovery ─────────────────────────────────────────────────────

  /**
   * Search LinkedIn for people using the Unipile search endpoint.
   * Supports keyword-based search or URL-based search (passing a LinkedIn search URL).
   */
  async searchPeople(accountId: string, params: {
    keywords?: string;
    url?: string;
    title?: string;
    company?: string;
    cursor?: string;
  }): Promise<any> {
    try {
      const { keywords, url, title, company, cursor } = params;
      this.log(`Searching LinkedIn people`, { accountId, keywords, url });
      const client = await this.getClient();

      let body: any;

      if (url) {
        // URL-based search: the URL overrides all other params
        body = { url };
      } else if (cursor) {
        // Pagination: just pass the cursor
        body = { cursor };
      } else {
        // Structured classic search
        body = {
          api: 'classic',
          category: 'people',
        };
        if (keywords) body.keywords = keywords;
        // title and company go into advanced_keywords for free-text matching
        if (title || company) {
          body.advanced_keywords = {};
          if (title) body.advanced_keywords.title = title;
          if (company) body.advanced_keywords.company = company;
        }
      }

      const result = await client.request.send({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: accountId },
        headers: { 'Content-Type': 'application/json' },
        body
      });
      this.log(`Search returned results`);
      return result;
    } catch (error: any) {
      return this.handleError(error, 'searchPeople');
    }
  }

  /**
   * Get a full LinkedIn profile by provider_id or identifier.
   * Exposes the internal getLinkedInProfile resolution as a public method
   * that works with raw provider_id strings (not just URLs).
   */
  async getProfile(identifier: string, accountId: string): Promise<any> {
    try {
      this.log(`Fetching profile: ${identifier}`, { accountId });
      const client = await this.getClient();
      const profile = await client.request.send({
        method: 'GET',
        path: ['users', identifier],
        parameters: { account_id: accountId }
      });
      this.log(`Successfully fetched profile: ${identifier}`);
      return profile;
    } catch (error: any) {
      return this.handleError(error, 'getProfile');
    }
  }

  /**
   * List the user's LinkedIn connections (1st-degree relations).
   */
  async listConnections(accountId: string, cursor?: string): Promise<any> {
    try {
      this.log(`Listing connections`, { accountId, cursor });
      const client = await this.getClient();
      const params: any = { account_id: accountId };
      if (cursor) params.cursor = cursor;
      const result = await client.users.getAllRelations(params);
      this.log(`Listed connections successfully`);
      return result;
    } catch (error: any) {
      return this.handleError(error, 'listConnections');
    }
  }

  /**
   * List sent connection invitations with their status.
   */
  async listSentInvitations(accountId: string, cursor?: string): Promise<any> {
    try {
      this.log(`Listing sent invitations`, { accountId, cursor });
      const client = await this.getClient();
      const params: any = { account_id: accountId };
      if (cursor) params.cursor = cursor;
      const result = await client.users.getAllInvitationsSent(params);
      this.log(`Listed sent invitations successfully`);
      return result;
    } catch (error: any) {
      return this.handleError(error, 'listSentInvitations');
    }
  }

  /**
   * List received connection invitations (pending requests from others).
   * Automatically enriches each item with sender profile data (name, headline, etc.)
   * using the sender_public_id field returned by the Unipile API.
   */
  async listReceivedInvitations(accountId: string, cursor?: string): Promise<any> {
    try {
      this.log(`Listing received invitations`, { accountId, cursor });
      const client = await this.getClient();
      const params: any = { account_id: accountId };
      if (cursor) params.cursor = cursor;
      const result = await (client as any).request.send({
        path: ['users', 'invite', 'received'],
        method: 'GET',
        parameters: params,
      });
      this.log(`Listed received invitations successfully`);

      // In Unipile's model: "inviter" object = person who sent the invite (sender),
      // "invited_user" string = the account holder (recipient = us).
      // inviter has: inviter_name, inviter_description, inviter_public_identifier, inviter_profile_picture_url
      if (result?.items && Array.isArray(result.items) && result.items.length > 0) {
        const enrichedItems = await Promise.all(result.items.map(async (item: any) => {
          const inviter = item.inviter || {};

          const senderProfile: any = {
            full_name: inviter.inviter_name || null,
            headline: inviter.inviter_description || null,
            profile_picture_url: inviter.inviter_profile_picture_url || null,
            public_id: inviter.inviter_public_identifier || null,
            provider_id: inviter.inviter_id || null,
          };

          // Optionally fetch a full profile for richer data (location, network_distance)
          if (senderProfile.public_id) {
            try {
              const profile = await client.request.send({
                method: 'GET',
                path: ['users', senderProfile.public_id],
                parameters: { account_id: accountId },
              }) as any;
              senderProfile.full_name = profile?.full_name || senderProfile.full_name;
              senderProfile.headline = profile?.headline || senderProfile.headline;
              senderProfile.location = profile?.location || null;
              senderProfile.network_distance = profile?.network_distance || null;
              senderProfile.profile_picture_url = profile?.profile_picture_url || senderProfile.profile_picture_url;
            } catch {
              // Profile fetch failed — inline data is still returned
            }
          }

          return { ...item, sender_profile: senderProfile };
        }));
        return { ...result, items: enrichedItems };
      }

      return result;
    } catch (error: any) {
      return this.handleError(error, 'listReceivedInvitations');
    }
  }

  /**
   * Accept a received connection invitation.
   * Unipile requires provider, shared_secret (from the invitation's specifics), account_id, and action.
   * The shared_secret is a per-invitation token returned by the list-received-invitations endpoint.
   */
  async acceptInvitation(invitationId: string, accountId: string, sharedSecret: string): Promise<any> {
    try {
      this.log(`Accepting invitation: ${invitationId}`, { accountId });
      const client = await this.getClient();
      const result = await (client as any).request.send({
        path: ['users', 'invite', 'received', invitationId],
        method: 'POST',
        body: {
          provider: 'LINKEDIN',
          shared_secret: sharedSecret,
          account_id: accountId,
          action: 'accept',
        },
        headers: { 'Content-Type': 'application/json' },
      });
      this.log(`Successfully accepted invitation: ${invitationId}`);
      return result;
    } catch (error: any) {
      return this.handleError(error, 'acceptInvitation');
    }
  }

  /**
   * Get a LinkedIn company profile.
   */
  async getCompanyProfile(companyId: string, accountId: string): Promise<any> {
    try {
      this.log(`Fetching company profile: ${companyId}`, { accountId });
      const client = await this.getClient();
      const result = await client.users.getCompanyProfile({
        account_id: accountId,
        identifier: companyId
      });
      this.log(`Successfully fetched company profile: ${companyId}`);
      return result;
    } catch (error: any) {
      return this.handleError(error, 'getCompanyProfile');
    }
  }

  /**
   * Cancel a pending connection invitation.
   */
  async cancelInvitation(invitationId: string, accountId: string): Promise<any> {
    try {
      this.log(`Cancelling invitation: ${invitationId}`, { accountId });
      const client = await this.getClient();
      const result = await client.users.cancelInvitationSent({
        account_id: accountId,
        invitation_id: invitationId
      });
      this.log(`Successfully cancelled invitation: ${invitationId}`);
      return result;
    } catch (error: any) {
      return this.handleError(error, 'cancelInvitation');
    }
  }

  /**
   * Fetch all messages exchanged with a specific LinkedIn contact (by their Unipile attendee/provider ID).
   * Paginates up to 10 pages (1000 messages). Filters out system events.
   */
  async getMessagesWithContact(
    attendeeId: string,
    opts?: { after?: string }
  ): Promise<Array<{ id: string; provider_id: string; text: string | null; is_sender: 0 | 1; is_event: 0 | 1; sender_id: string; timestamp: string }>> {
    const MAX_PAGES = 10;
    const messages: any[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const client = await this.getClient();

    do {
      const params: any = { attendee_id: attendeeId, limit: 100 };
      if (cursor) params.cursor = cursor;
      else if (opts?.after) params.after = opts.after;

      const result = await client.messaging.getAllMessagesFromAttendee(params);

      if (result?.items) {
        for (const msg of result.items) {
          if (msg.is_event === 1) continue;
          messages.push(msg);
        }
      }

      cursor = (result as any)?.cursor ?? undefined;
      pages++;
    } while (cursor && pages < MAX_PAGES);

    return messages;
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

  /**
   * Resolve a Unipile account_id for a given user.
   * 1. Uses the user's own connected Unipile account if available.
   * 2. Falls back to a randomly-selected site-wide Unipile account configured in settings.
   * Returns null if no account can be found.
   */
  async resolveAccountId(userId: string): Promise<string | null> {
    // 1. User's own account
    try {
      const { getAccountsByUserId } = await import('./connectedAccountsDb');
      const accounts = await getAccountsByUserId(userId);
      const userAccount = accounts.find((a: any) => a.platform === 'unipile');
      if (userAccount?.account_id) return userAccount.account_id;
    } catch { /* ignore */ }

    // 2. Site-wide accounts — verify each one is still connected before returning
    try {
      const { settingsService } = await import('./settingsService');
      const setting = await settingsService.getSetting('site-wide-unipile-accounts');
      if (setting?.settingValue) {
        const siteAccounts = JSON.parse(setting.settingValue);
        const enabled = (siteAccounts as any[]).filter((a) => a.enabled !== false);
        // Shuffle so load is distributed across accounts
        const shuffled = enabled.sort(() => Math.random() - 0.5);
        for (const account of shuffled) {
          if (await this.isAccountConnected(account.account_id)) {
            return account.account_id;
          }
          this.log(`Site-wide account ${account.account_id} (${account.account_name}) is disconnected — skipping`);
        }
      }
    } catch { /* ignore parse errors or settings fetch failures */ }

    return null;
  }
}

export const linkedInOutreachService = new LinkedInOutreachService();
