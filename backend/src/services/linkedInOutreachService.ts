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
  private connectedStatusCache: Map<string, { state: 'connected' | 'disconnected' | 'unknown'; timestamp: number }> = new Map();
  private static readonly CONNECTED_STATUS_TTL_MS = 10 * 60 * 1000; // 10 minutes
  // Per-user resolved account cache — avoids re-running the full account resolution chain on every call
  private resolvedAccountCache: Map<string, { accountId: string; timestamp: number }> = new Map();
  private static readonly RESOLVED_ACCOUNT_TTL_MS = 30 * 60 * 1000; // 30 minutes
  // Per-account invitation cooldown breaker (ENG-126). Once LinkedIn rejects a
  // send-invite with "Cannot resend yet", the account has hit its invitation cap
  // and EVERY subsequent invite — to any recipient — fails the same way until the
  // cap resets. We record the epoch-ms until which further sends are short-circuited
  // (no Unipile round-trip), so a runaway session or scheduled run can't burn attempt
  // after attempt across fresh recipients. Self-heals on TTL expiry or the next
  // successful send. Scoped per account_id, so one throttled account never blocks
  // another. Note: the per-recipient "Should delay new invitation" rejection does
  // NOT arm this breaker — that one is specific to a single recipient.
  private invitationCooldownUntil: Map<string, number> = new Map();
  private static readonly INVITATION_COOLDOWN_TTL_MS = 60 * 60 * 1000; // 1 hour

  // ─── Logging helpers ────────────────────────────────────────────────────────

  private log(message: string, data?: any) {
    console.log(`[LinkedInOutreachService] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  // Warnings go to stderr, which Elastic Beanstalk also captures into the
  // web.stdout.log CloudWatch group — so these markers are queryable there by
  // time window (14-day retention). Kept single-line + prefixed so a future
  // profile-lookup hang is greppable without spelunking (see ENG-144).
  private warn(message: string, data?: any) {
    console.warn(`[LinkedInOutreachService] ${message}`, data ? JSON.stringify(data) : '');
  }

  private async handleError(error: any, context: string): Promise<never> {
    console.error(`[LinkedInOutreachError] --- START ERROR LOG ---`);
    console.error(`[LinkedInOutreachError] Context: ${context}`);

    // Unipile's UnsuccessfulRequestError uses error.body; fall back through all formats.
    // error.body can also be a Blob: the SDK's RequestSender calls response.blob()
    // whenever Unipile's error response isn't application/json (e.g. a gateway/proxy
    // error page, or a plain-text session error), and UnsuccessfulRequestError's own
    // .message is always ''. Without unwrapping it here, those errors silently collapse
    // to "Unknown error" below, hiding the real reason (e.g. a dead LinkedIn session).
    let rawBody = error.response?.data || error.response || error.body;
    if (rawBody instanceof Blob) {
      try {
        const text = (await rawBody.text()).trim();
        rawBody = text ? { message: text.slice(0, 500) } : {};
      } catch {
        rawBody = {};
      }
    }
    const responseData = rawBody || {};

    const structuredError: any = {
      message: responseData.message || responseData.title || responseData.detail || error.message || 'Unknown error',
      code: responseData.code || responseData.type || error.code,
      status: error.response?.status || responseData.status || error.status,
      details: responseData.details || responseData.detail || error.details,
      classification: 'UNKNOWN_ERROR'
    };

    // Internal timeouts (from withTimeout) have no HTTP status — preserve the
    // TIMEOUT_ERROR classification so callers/agent can surface a retry-friendly
    // message instead of a generic "Unknown error".
    if (error?.isTimeout || error?.classification === 'TIMEOUT_ERROR') {
      structuredError.classification = 'TIMEOUT_ERROR';
      structuredError.isTimeout = true;
    }

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

  // ─── Timeout / retry helpers ─────────────────────────────────────────────────

  // Profile lookups occasionally hang when Unipile's upstream LinkedIn session is
  // stuck (CAPTCHA/auth wall or a dead browser session). The Unipile SDK's fetch
  // has no timeout, so a hung request blocks the agent for minutes — a real session
  // (ENG-144) waited 167s before failing and returned no data. Bound each lookup
  // with an internal timeout and one automatic retry so we surface a clear,
  // classified error quickly instead of stalling the conversation.
  static readonly PROFILE_LOOKUP_TIMEOUT_MS = 30_000;
  // Healthy lookups return in ~1–3s (confirmed against prod CloudWatch logs). A
  // success slower than this is an early warning that the upstream is degrading
  // toward the ENG-144 hang — logged so we catch trouble before it's a full
  // timeout.
  static readonly PROFILE_LOOKUP_SLOW_MS = 10_000;
  // Liveness probe timeout for isAccountConnected. Shorter than a real profile
  // lookup: a hung probe should be treated as "not connected" quickly so
  // resolveAccountId moves on to the next account instead of stalling the whole
  // request on the same upstream hang ENG-144 is about.
  static readonly CONNECTIVITY_CHECK_TIMEOUT_MS = 15_000;

  /**
   * Race a promise against a timeout. If the timeout fires first, reject with a
   * TIMEOUT_ERROR-classified Error carrying `isTimeout = true`. The underlying
   * promise is left to settle on its own (the SDK's fetch is not abortable), but
   * the caller is unblocked. The timer is unref'd so it never keeps the process
   * alive and is always cleared once the race settles.
   */
  private static withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err: any = new Error(`${label} timed out after ${ms}ms`);
        err.isTimeout = true;
        err.classification = 'TIMEOUT_ERROR';
        reject(err);
      }, ms);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Fetch a full LinkedIn profile from Unipile with a bounded timeout and a single
   * automatic retry on timeout. Non-timeout errors (404/401/etc.) bubble straight
   * up to the caller's handleError without a retry — retrying those just wastes
   * credits. Shared by getLinkedInProfile (URL input) and getProfile (raw id).
   */
  private async fetchProfileFromUnipile(identifier: string, accountId: string): Promise<any> {
    const client = await this.getClient();
    const doFetch = () => client.request.send({
      method: 'GET',
      path: ['users', identifier],
      // linkedin_sections='*' returns ALL profile sections (experience,
      // education, skills, languages, certifications, volunteer, etc.).
      parameters: { account_id: accountId, linkedin_sections: '*' }
    });

    // One timed attempt. Emits structured, greppable markers so a future hang is
    // diagnosable straight from CloudWatch given only a time window:
    //   PROFILE_LOOKUP_TIMEOUT — this attempt exceeded PROFILE_LOOKUP_TIMEOUT_MS
    //   PROFILE_LOOKUP_SLOW    — succeeded, but slower than the healthy baseline
    // Every marker carries identifier + accountId + attempt + elapsedMs.
    const attemptFetch = async (attempt: number): Promise<any> => {
      const startedAt = Date.now();
      try {
        const result = await LinkedInOutreachService.withTimeout(
          doFetch(),
          LinkedInOutreachService.PROFILE_LOOKUP_TIMEOUT_MS,
          `LinkedIn profile lookup for ${identifier}`
        );
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= LinkedInOutreachService.PROFILE_LOOKUP_SLOW_MS) {
          this.warn('PROFILE_LOOKUP_SLOW', { identifier, accountId, attempt, elapsedMs });
        }
        return result;
      } catch (err: any) {
        if (err?.isTimeout) {
          this.warn('PROFILE_LOOKUP_TIMEOUT', {
            identifier,
            accountId,
            attempt,
            elapsedMs: Date.now() - startedAt,
            timeoutMs: LinkedInOutreachService.PROFILE_LOOKUP_TIMEOUT_MS,
          });
        }
        throw err;
      }
    };

    try {
      return await attemptFetch(1);
    } catch (err: any) {
      if (!err?.isTimeout) throw err; // real API error — surface immediately, no retry
      this.log(`Profile lookup timed out; retrying once`, { identifier, accountId });
      try {
        return await attemptFetch(2);
      } catch (retryErr: any) {
        if (retryErr?.isTimeout) {
          // Both attempts hung — this is the ENG-144 failure. One clear ERROR-level
          // marker to alert on / grep for when a user reports "no data returned".
          this.warn('PROFILE_LOOKUP_FAILED_TIMEOUT', {
            identifier,
            accountId,
            attempts: 2,
            timeoutMs: LinkedInOutreachService.PROFILE_LOOKUP_TIMEOUT_MS,
          });
        }
        throw retryErr;
      }
    }
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
  clearStatusCache(accountId: string): void {
    this.connectedStatusCache.delete(accountId);
  }

  invalidateResolvedAccount(userId: string): void {
    this.resolvedAccountCache.delete(userId);
  }

  /**
   * Tri-state session probe (ENG-281).
   *
   * `isAccountConnected` collapses "the session is definitively dead" and "the probe
   * could not tell" into a single `false`. That is fine for callers that merely skip
   * to the next account, but a caller that BLOCKS an action on the result must not
   * treat a timeout or a network blip as proof of disconnection — doing so suppresses
   * a healthy account and tells the user to reconnect for no reason, for the whole
   * 10-minute cache window.
   *
   * So: `'disconnected'` only for signals that actually mean the LinkedIn session is
   * gone (Unipile `errors/disconnected_account`, HTTP 401, or an AUTH_ERROR
   * classification — the same signals the reactive handler keys on). Everything else
   * (timeout, 5xx, network, client-init failure) is `'unknown'`, and the caller
   * decides. `isAccountConnected` keeps its exact previous semantics on top of this.
   */
  async probeAccountSession(accountId: string): Promise<'connected' | 'disconnected' | 'unknown'> {
    const cached = this.connectedStatusCache.get(accountId);
    if (cached && Date.now() - cached.timestamp < LinkedInOutreachService.CONNECTED_STATUS_TTL_MS) {
      return cached.state;
    }
    let state: 'connected' | 'disconnected' | 'unknown';
    try {
      const client = await this.getClient();
      const timeoutMs = LinkedInOutreachService.CONNECTIVITY_CHECK_TIMEOUT_MS;
      // account.getOne() returns account metadata but no session status field.
      // Use the account's own LinkedIn publicIdentifier for a self-profile lookup —
      // this fails with 401 if the LinkedIn session is disconnected. Both Unipile
      // calls are timeout-bounded so a hung upstream (ENG-144) can't stall the
      // caller (resolveAccountId loops this over every account) — a probe that
      // times out is treated as "not connected" and resolution moves on.
      const account = await LinkedInOutreachService.withTimeout(
        client.account.getOne(accountId) as Promise<any>,
        timeoutMs,
        `LinkedIn connectivity check (account) for ${accountId}`,
      ) as any;
      const publicIdentifier = account?.connection_params?.im?.publicIdentifier;
      if (!publicIdentifier) {
        this.log(`Account ${accountId} has no publicIdentifier — assuming connected`);
        state = 'connected';
      } else {
        await LinkedInOutreachService.withTimeout(
          client.request.send({
            method: 'GET',
            path: ['users', publicIdentifier],
            parameters: { account_id: accountId },
          }),
          timeoutMs,
          `LinkedIn connectivity check (profile) for ${accountId}`,
        );
        state = 'connected';
      }
    } catch (error: any) {
      // Unipile surfaces this on `body`; our own wrapper re-shapes it onto
      // `structuredError`. Read both so the classification cannot depend on which
      // layer threw.
      const structured = error?.structuredError;
      const code = structured?.code || error?.body?.code || error?.code || '';
      const status = structured?.status || error?.body?.status || error?.status;
      const classification = structured?.classification || error?.body?.classification || error?.classification;
      // Only these mean "the LinkedIn session is gone". A timeout or transport
      // failure proves nothing about the session, so it must not be reported as
      // a disconnection to a caller that would block on it.
      const definitivelyDisconnected =
        code === 'errors/disconnected_account' ||
        classification === 'AUTH_ERROR' ||
        Number(status) === 401;
      state = definitivelyDisconnected ? 'disconnected' : 'unknown';
      this.log(`Account ${accountId} connectivity check failed (${status} ${code}${error?.isTimeout ? ' timeout' : ''}) → ${state}`);
    }
    this.connectedStatusCache.set(accountId, { state, timestamp: Date.now() });
    return state;
  }

  async isAccountConnected(accountId: string): Promise<boolean> {
    // Unchanged semantics for every pre-existing caller: anything that is not a
    // proven-live session is `false`, including an indeterminate probe.
    return (await this.probeAccountSession(accountId)) === 'connected';
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

  /**
   * Fetch every account registered in Unipile (all pages), regardless of whether
   * it exists in our DB. Used by the admin view to detect orphaned accounts that
   * were not cleaned up when the AgentWeb user was deleted or disconnected.
   */
  async getAllUnipileAccounts(): Promise<Array<{ id: string; name: string; type: string; created_at?: string }>> {
    const client = await this.getClient();
    const items: any[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await client.account.getAll(cursor ? { cursor } : undefined);
      if (res?.items) items.push(...res.items);
      cursor = res?.cursor || undefined;
    } while (cursor);
    return items.map((item: any) => ({
      id: item.id,
      name: item.name ?? item.connection_params?.im?.publicIdentifier ?? item.id,
      type: item.type,
      created_at: item.created_at,
    }));
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
      const profile = await this.fetchProfileFromUnipile(identifier, account_id);
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
  // LinkedIn invitation-note limits depend on the account tier:
  //  - Free accounts: 200 characters
  //  - Premium accounts: 300 characters (also LinkedIn's absolute maximum)
  static readonly INVITE_MESSAGE_MAX_CHARS = 300;
  static readonly INVITE_MESSAGE_MAX_CHARS_FREE = 200;

  /**
   * Resolve the invitation-note character limit for a given account: 300 for a
   * Premium account (config.is_premium === true), 200 otherwise. Falls back to the
   * free limit if the account can't be read, so we never over-promise capacity.
   */
  async getInviteCharLimitForAccount(userId: string, accountId: string): Promise<number> {
    try {
      const { getAccountsByUserIdIncludingOrgShared } = await import('./connectedAccountsDb');
      const accounts = await getAccountsByUserIdIncludingOrgShared(userId);
      const account = (accounts as any[]).find(
        (a) => a.platform === 'unipile' && a.account_id === accountId
      );
      if (account?.config?.is_premium === true) {
        return LinkedInOutreachService.INVITE_MESSAGE_MAX_CHARS;
      }
    } catch { /* ignore — fall through to the free limit */ }
    return LinkedInOutreachService.INVITE_MESSAGE_MAX_CHARS_FREE;
  }

  /**
   * Trim an invitation note to the per-account character limit, preferring a
   * sentence boundary (dropping an incomplete trailing sentence), then a word
   * boundary, so we never cut mid-word. Returns the message unchanged when it
   * already fits. LinkedIn hard-rejects over-limit notes, so we trim deterministically
   * here rather than throwing — the LLM cannot reliably count characters, and a throw
   * just triggers a regenerate-and-retry loop (it produced 203/204/207/210-char notes
   * in a real session). Trimming at the chokepoint guarantees the send never fails on
   * length for either the agent path or the human CRM path.
   */
  static trimInviteMessage(message: string, maxChars: number): string {
    if (message.length <= maxChars) return message;
    let hardCut = message.slice(0, maxChars);
    // slice() works on UTF-16 code units, so a cut can land between the two halves
    // of a surrogate pair (e.g. an emoji), leaving a malformed lone surrogate. Drop a
    // dangling high surrogate so we never emit invalid UTF-16 to LinkedIn.
    const lastUnit = hardCut.charCodeAt(hardCut.length - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) hardCut = hardCut.slice(0, -1);
    // Threshold (60% of the budget) below which we won't honour a cut point — keeping
    // it would throw away too much of the note (e.g. a tiny leading "Hi." sentence).
    const minKeep = Math.floor(maxChars * 0.6);
    // Prefer a sentence boundary so we drop an incomplete trailing sentence rather than
    // cutting mid-sentence on a word. Find the last sentence-ending punctuation in budget.
    const lastSentenceEnd = Math.max(
      hardCut.lastIndexOf('.'),
      hardCut.lastIndexOf('!'),
      hardCut.lastIndexOf('?'),
    );
    if (lastSentenceEnd >= minKeep) {
      return hardCut.slice(0, lastSentenceEnd + 1).replace(/\s+$/, '');
    }
    // No usable sentence end — fall back to the last whitespace so we keep whole words.
    // Only honour it when it retains most of the budget; otherwise (one giant token) hard-cut.
    const lastSpace = hardCut.lastIndexOf(' ');
    const candidate = lastSpace >= minKeep ? hardCut.slice(0, lastSpace) : hardCut;
    return candidate.replace(/\s+$/, '');
  }

  async sendInvitation(
    account_id: string,
    profileUrlOrId: string,
    isUrl: boolean,
    message?: string,
    maxChars: number = LinkedInOutreachService.INVITE_MESSAGE_MAX_CHARS,
    opts?: { onNoteQuota?: 'send_without_note' | 'skip' }
  ): Promise<any> {
    // Policy for when LinkedIn rejects the personalized note because the account's
    // monthly note quota is spent (ENG-213). The service is a pure mechanism — the
    // caller decides. 'send_without_note' drops the note and sends anyway (legacy
    // behavior; kept as the default so existing callers are unaffected). 'skip'
    // HOLDS the invite: it throws a typed `noteQuotaExceeded` signal WITHOUT sending,
    // so the caller can ask the customer (CRM dialog / Emma) or defer the lead
    // instead of silently downgrading a note the customer deliberately wrote.
    const onNoteQuota: 'send_without_note' | 'skip' = opts?.onNoteQuota ?? 'send_without_note';

    // Account-level cooldown breaker: if a prior send already hit LinkedIn's
    // invitation cap, skip the network round-trip entirely and fail fast with the
    // same signal, so callers (agent-mode, CRM) stop burning attempts recipient
    // after recipient. The message keeps the "Cannot resend yet" phrase so the
    // agent-mode handler surfaces it as the account-level throttle it is.
    const cooldownUntil = this.invitationCooldownUntil.get(account_id);
    if (cooldownUntil !== undefined) {
      if (cooldownUntil > Date.now()) {
        this.log(`Skipping invite — account under invitation cooldown`, { account_id, cooldownUntil });
        const err: any = new Error(
          'Cannot resend yet — this LinkedIn account is under an active account-level invitation ' +
          'cooldown (its invitation cap was hit on an earlier send this run); skipped to avoid burning attempts.'
        );
        err.structuredError = { message: err.message, classification: 'VALIDATION_ERROR', status: 422 };
        throw err;
      }
      // Cooldown window elapsed — clear it and allow a fresh attempt.
      this.invitationCooldownUntil.delete(account_id);
    }

    let outgoingMessage = message;
    if (outgoingMessage !== undefined && outgoingMessage.length > maxChars) {
      const trimmed = LinkedInOutreachService.trimInviteMessage(outgoingMessage, maxChars);
      this.log(`Invitation note over limit — auto-trimmed`, {
        originalLength: outgoingMessage.length,
        trimmedLength: trimmed.length,
        maxChars,
      });
      outgoingMessage = trimmed;
    }
    try {
      const resolvedTarget = await this.resolveProviderId(profileUrlOrId, isUrl, account_id);
      // Unipile's invite endpoint requires the canonical provider_id (the member URN);
      // a public-identifier slug (e.g. "william-kwak") is rejected with a generic
      // "Invalid parameters" (ENG-213). The connection-check profile fetch accepts
      // either form and reveals the canonical provider_id, so use that for the send
      // rather than whatever identifier the caller happened to pass.
      const provider_id = await this.checkIsNotAlreadyConnected(account_id, resolvedTarget);
      this.log(`Sending invitation`, { account_id, provider_id });
      const client = await this.getClient();
      const res = await this.sendInvitationRequest(client, account_id, provider_id, outgoingMessage, onNoteQuota);
      this.log(`Invitation sent successfully`, { account_id, provider_id });
      // A successful send proves the account is not capped — clear any stale breaker.
      this.invitationCooldownUntil.delete(account_id);
      return res;
    } catch (error: any) {
      // A note-quota HOLD (onNoteQuota:'skip') is an intentional, already-classified
      // signal — surface it verbatim so callers can gate on `noteQuotaExceeded`.
      // Running it through handleError would re-classify it as a generic validation
      // error and strip the flag.
      if (error?.noteQuotaExceeded) throw error;
      // handleError always throws; inspect the normalized message it produces so
      // an account-level "Cannot resend yet" arms the breaker for future calls.
      // Per-recipient rejections (e.g. "Should delay new invitation") do not match
      // and so never arm the account-wide breaker.
      try {
        return await this.handleError(error, 'sendInvitation');
      } catch (enhanced: any) {
        if (/cannot resend yet/i.test(enhanced?.message ?? '')) {
          this.invitationCooldownUntil.set(
            account_id,
            Date.now() + LinkedInOutreachService.INVITATION_COOLDOWN_TTL_MS
          );
          this.log(`Armed invitation cooldown breaker`, { account_id });
        }
        throw enhanced;
      }
    }
  }

  /**
   * Send the invite to Unipile. Free LinkedIn accounts may only attach a note to ~5
   * invitations per month, but can still send ~150 note-less invites per week; once
   * the monthly note quota is spent, LinkedIn rejects every note-bearing invite with
   * a generic "Invalid parameters" even though the recipient/provider_id are perfectly
   * valid (ENG-213). What we do about that is the CALLER's policy, via `onNoteQuota`:
   *   - 'send_without_note': transparently resend WITHOUT the note so the connection
   *     request still goes out, tagging the result `note_dropped` so callers report it.
   *   - 'skip': do NOT send — throw a typed `noteQuotaExceeded` signal so the caller
   *     can ask the customer or hold the lead instead of silently dropping the note.
   * Any non-note rejection (bad provider_id, already-invited, account cap) bubbles up
   * unchanged for the caller/handleError to classify, regardless of `onNoteQuota`.
   */
  private async sendInvitationRequest(
    client: UnipileClient,
    account_id: string,
    provider_id: string,
    message: string | undefined,
    onNoteQuota: 'send_without_note' | 'skip',
  ): Promise<any> {
    try {
      return await client.users.sendInvitation({ account_id, provider_id, message });
    } catch (error: any) {
      const hadNote = typeof message === 'string' && message.length > 0;
      if (hadNote && LinkedInOutreachService.isInviteNoteRejection(error)) {
        if (onNoteQuota === 'skip') {
          // Hold: the note quota is spent and the caller has NOT authorized a note-less
          // send. Do not downgrade silently — surface a typed signal so the caller can
          // ask the customer (or defer the lead). The invite is NOT sent.
          this.warn('INVITE_NOTE_QUOTA_HELD', { account_id, provider_id });
          const held: any = new Error(
            'LinkedIn note quota reached — the personalized note could not be attached. ' +
            'The invitation was held (not sent) so the note is not silently dropped.'
          );
          held.noteQuotaExceeded = true;
          held.structuredError = {
            message: held.message,
            classification: 'NOTE_QUOTA_EXCEEDED',
            status: 422,
            noteQuotaExceeded: true,
          };
          throw held;
        }
        this.warn('INVITE_NOTE_REJECTED_RETRY_WITHOUT_NOTE', { account_id, provider_id });
        const res = await client.users.sendInvitation({ account_id, provider_id, message: undefined });
        // Signal to callers that the note was dropped — the invite still went out,
        // just without the personalization, so they can report it accurately.
        if (res && typeof res === 'object') (res as any).note_dropped = true;
        return res;
      }
      throw error;
    }
  }

  /**
   * True when a Unipile invite rejection is the generic "Invalid parameters"
   * validation error LinkedIn returns for a note-bearing invite once a free
   * account's monthly personalized-invite quota is spent (ENG-213). Deliberately
   * excludes the distinct cap/duplicate signals ("cannot resend yet",
   * "already invited/connected", "should delay") — dropping the note cannot fix
   * those, so we must not silently retry and mask them.
   */
  private static isInviteNoteRejection(error: any): boolean {
    const body = error?.body;
    if (!body || typeof body !== 'object' || (typeof Blob !== 'undefined' && body instanceof Blob)) {
      return false;
    }
    const text = [body.title, body.message, body.detail, body.type]
      .filter((v: any) => typeof v === 'string')
      .join(' ')
      .toLowerCase();
    if (!text) return false;
    if (/cannot resend yet|already invited|already connected|should delay|insufficient/.test(text)) {
      return false;
    }
    return /invalid parameters?/.test(text);
  }

  /**
   * Check that a target profile is not already a 1st-degree connection before sending an invite.
   * Uses raw API call to avoid SDK validator failures.
   *
   * Returns the canonical Unipile provider_id (member URN) revealed by the profile
   * lookup. The lookup accepts either a public-identifier slug or a provider_id, but
   * the invite endpoint only accepts the canonical provider_id — so callers must send
   * the returned value, not the identifier they passed in (ENG-213). Falls back to the
   * passed identifier when the lookup fails or reveals no provider_id, so a transient
   * lookup failure never blocks (or breaks) the invite.
   */
  private async checkIsNotAlreadyConnected(accountId: string, providerId: string): Promise<string> {
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
        // Self-heal: the live API says we're connected but the cache evidently didn't
        // (or the CRM wouldn't have offered the invite). Upsert this connection so the
        // CRM stops offering the invite immediately, without waiting for the next full
        // sync. Non-fatal — never let a cache write block the already-connected guard.
        await this.cacheLiveConnection(accountId, profile).catch((err) =>
          this.log(`Self-heal connection cache write skipped`, { providerId, reason: err?.message }),
        );
        throw new Error(
          `Cannot send invite: you are already connected with this person (network_distance: ${distance}). ` +
          `Use the send-message action to reach them directly.`
        );
      }
      // Prefer the canonical provider_id from the live profile — the invite endpoint
      // rejects a public-identifier slug with "Invalid parameters".
      const canonical = profile?.provider_id;
      return typeof canonical === 'string' && canonical.length > 0 ? canonical : providerId;
    } catch (error: any) {
      if (error.message?.startsWith('Cannot send invite:')) throw error;
      // Profile lookup failed — log and proceed with the identifier we were given
      // rather than blocking the invite.
      this.log(`Connection status check skipped (profile fetch failed)`, { providerId, reason: error.message });
      return providerId;
    }
  }

  /**
   * Upsert a single live 1st-degree connection into AW-UnipileConnections. Used to
   * self-heal a stale cache that was missing a genuinely-connected lead. Best-effort:
   * skips silently if the profile lacks a usable public URL/member id.
   */
  private async cacheLiveConnection(accountId: string, profile: any): Promise<void> {
    const publicId: string | undefined = profile?.public_identifier || profile?.provider_id;
    const memberId: string | undefined = profile?.member_id || publicId;
    if (!memberId) return;

    const {
      upsertConnections,
      normalizeLinkedInUrl,
    } = await import('./unipileConnectionsDb');

    const profileUrl = normalizeLinkedInUrl(
      profile?.public_profile_url ||
      (publicId ? `https://www.linkedin.com/in/${publicId}/` : ''),
    );
    if (!profileUrl) return;

    await upsertConnections([{
      accountId,
      memberId,
      publicProfileUrl: profileUrl,
      memberUrn: profile?.member_urn ?? '',
      connectionUrn: profile?.connection_urn ?? '',
      firstName: profile?.first_name ?? '',
      lastName: profile?.last_name ?? '',
      headline: profile?.headline ?? '',
      connectedAt: profile?.created_at ?? 0,
      syncedAt: new Date().toISOString(),
    }]);
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
   *
   * Structured ID filters (`company_id`, `location_id`, `industry_id`,
   * `school_id`) are forwarded as top-level body keys per Unipile's classic
   * people-search schema (arrays of numeric IDs; `industry` is an object with
   * include/exclude arrays). See https://developer.unipile.com/docs/linkedin-search.
   *
   * When the caller passes free-text (e.g. `company: 'Microsoft'`) without the
   * matching `*_id`, this method calls UnipileSearchParamService.resolveTopId()
   * to look up the LinkedIn entity ID. Resolver miss (null) or resolver error
   * → fall back to the original `advanced_keywords` free-text behavior so the
   * search never blocks on resolution failures.
   */
  async searchPeople(accountId: string, params: {
    keywords?: string;
    url?: string;
    title?: string;
    company?: string;
    company_id?: string;
    location?: string;
    location_id?: string;
    industry?: string;
    industry_id?: string;
    school?: string;
    school_id?: string;
    cursor?: string;
  }): Promise<any> {
    try {
      const {
        keywords, url, title,
        company, company_id,
        location, location_id,
        industry, industry_id,
        school, school_id,
        cursor,
      } = params;
      this.log(`Searching LinkedIn people`, { accountId, keywords, url });
      const client = await this.getClient();

      let body: any;

      if (cursor) {
        // Pagination: cursor wins over url because the cursor payload already
        // encodes the original URL/filter set. Sending `{ url }` here would
        // make Unipile re-run the search from page 1 on every iteration of
        // a top-up loop — see find-leads "200 found / 1 imported" regression.
        body = { cursor };
      } else if (url) {
        // URL-based search (first page): the URL overrides all other params.
        body = { url };
      } else {
        // Structured classic search
        body = {
          api: 'classic',
          category: 'people',
        };

        // Unipile's classic /linkedin/search rejects calls without one of
        // keywords / search_url / cursor — even when structured filters
        // (company, title, etc.) are provided. Empty string also fails.
        // To keep the Emma tool surface honest ("just pass title+company"),
        // synthesize keywords from the most-specific filter when omitted.
        // User-provided keywords always wins.
        const synthesizedKeywords = keywords
          || title
          || company
          || location
          || industry
          || school;
        if (synthesizedKeywords) body.keywords = synthesizedKeywords;

        // Resolve free-text → ID for each structured filter when the *_id
        // companion isn't already provided. Pre-resolved *_id always wins.
        const resolvedCompanyId = company_id
          || (company ? await this.resolveSearchParamId('COMPANY', company, accountId) : null);
        const resolvedLocationId = location_id
          || (location ? await this.resolveSearchParamId('LOCATION', location, accountId) : null);
        const resolvedIndustryId = industry_id
          || (industry ? await this.resolveSearchParamId('INDUSTRY', industry, accountId) : null);
        const resolvedSchoolId = school_id
          || (school ? await this.resolveSearchParamId('SCHOOL', school, accountId) : null);

        if (resolvedCompanyId) body.company = [resolvedCompanyId];
        if (resolvedLocationId) body.location = [resolvedLocationId];
        if (resolvedIndustryId) body.industry = { include: [resolvedIndustryId], exclude: [] };
        if (resolvedSchoolId) body.school = [resolvedSchoolId];

        // Free-text fallback for anything that didn't resolve (and for title
        // which has no ID equivalent). Preserves the previous behavior so
        // searches never block on resolver misses or resolver outages.
        const advanced: Record<string, string> = {};
        if (title) advanced.title = title;
        if (company && !resolvedCompanyId) advanced.company = company;
        if (location && !resolvedLocationId) advanced.location = location;
        if (industry && !resolvedIndustryId) advanced.industry = industry;
        if (school && !resolvedSchoolId) advanced.school = school;
        if (Object.keys(advanced).length > 0) {
          body.advanced_keywords = advanced;
        }
      }

      const result = await client.request.send({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: accountId },
        headers: { 'Content-Type': 'application/json' },
        body
      });
      this.log(`Search returned results`, { result });
      return result;
    } catch (error: any) {
      return this.handleError(error, 'searchPeople');
    }
  }

  /**
   * Best-effort lookup of a LinkedIn entity ID via UnipileSearchParamService.
   * Returns null on any failure (resolver not initialized, cache/API error,
   * empty result) so the caller can fall back to free-text. Never throws —
   * resolver outages must not block the underlying search.
   */
  async resolveCompanyId(company: string, accountId: string): Promise<string | null> {
    return this.resolveSearchParamId('COMPANY', company, accountId);
  }

  private async resolveSearchParamId(
    type: 'COMPANY' | 'LOCATION' | 'INDUSTRY' | 'SCHOOL' | 'SERVICE',
    keywords: string,
    accountId: string,
  ): Promise<string | null> {
    try {
      // Use the factory's lazy-init getter, not the bare service's throwing
      // getter. The factory transparently constructs the singleton in forked
      // worker subprocesses (e.g. generateMarketingResponseWorker) where
      // server.ts's boot wiring never runs.
      const { getUnipileSearchParamService } = await import('./unipileSearchParamServiceFactory');
      const svc = getUnipileSearchParamService();
      const id = await svc.resolveTopId(accountId, { type, keywords });
      return id ?? null;
    } catch (error: any) {
      this.log(`Search-param resolve failed (${type}=${keywords}); falling back to free-text`, {
        reason: error?.message,
      });
      return null;
    }
  }

  /**
   * Resolve free-text keywords to LinkedIn entity candidates (company,
   * location, industry, school, service). Maps to Unipile's
   * GET /linkedin/search/parameters endpoint.
   *
   * Callers should go through UnipileSearchParamService for caching +
   * telemetry; this raw method is the HTTP transport that factory wires.
   */
  async searchParameters(
    accountId: string,
    args: { type: 'COMPANY' | 'LOCATION' | 'INDUSTRY' | 'SCHOOL' | 'SERVICE'; keywords: string; limit?: number }
  ): Promise<any> {
    try {
      this.log(`Searching LinkedIn parameters`, { accountId, type: args.type, keywords: args.keywords });
      const client = await this.getClient();
      const parameters: Record<string, any> = {
        account_id: accountId,
        type: args.type,
        keywords: args.keywords,
      };
      if (args.limit !== undefined) parameters.limit = args.limit;
      const result = await client.request.send({
        method: 'GET',
        path: ['linkedin', 'search', 'parameters'],
        parameters,
      });
      return result;
    } catch (error: any) {
      return this.handleError(error, 'searchParameters');
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
      const profile = await this.fetchProfileFromUnipile(identifier, accountId);
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
      if (result?.items?.length > 0) {
        const enrichedItems = await Promise.all(result.items.map(async (item: any) => {
          const inviter = item.inviter || {};

          const senderProfile: any = {
            full_name: inviter.inviter_name || null,
            headline: inviter.inviter_description || null,
            profile_picture_url: inviter.inviter_profile_picture_url || null,
            public_id: inviter.inviter_public_identifier || null,
            provider_id: inviter.inviter_id || null,
          };

          // Optionally fetch a full profile for richer data (location, etc).
          // Routed through the cache-first wrapper to avoid hammering Unipile
          // when the same inviter shows up across multiple invitations or page
          // refreshes. network_distance is viewer-relative so the cached path
          // can't return it; not required here since received invitations are
          // by definition from non-1st-degree senders.
          if (senderProfile.public_id) {
            try {
              const { getUnipileProfileServiceSingleton } = await import('./unipileProfileService');
              const svc = getUnipileProfileServiceSingleton();
              const profile = svc
                ? (await svc.getProfile(senderProfile.public_id, accountId)).rawData
                : await client.request.send({
                    method: 'GET',
                    path: ['users', senderProfile.public_id],
                    parameters: { account_id: accountId, linkedin_sections: '*' },
                  }) as any;
              senderProfile.full_name = profile?.full_name || senderProfile.full_name;
              senderProfile.headline = profile?.headline || senderProfile.headline;
              senderProfile.location = profile?.location || null;
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
   * Fetch all messages exchanged with a specific LinkedIn contact.
   * Uses getAllChatsFromAttendee (which accepts account_id) to find the chat, then
   * getAllMessagesFromChat to retrieve messages — this is the only path where Unipile
   * sets is_sender=1 correctly for outbound messages.
   * getAllMessagesFromAttendee does NOT accept account_id so is_sender is always 0 there.
   */
  async getMessagesWithContact(
    attendeeId: string,
    account_id: string,
    opts?: { after?: string }
  ): Promise<Array<{ id: string; provider_id: string; text: string | null; is_sender: 0 | 1; is_event: 0 | 1; sender_id: string; timestamp: string }>> {
    const client = await this.getClient();

    // Step 1: find the chat between our account and this attendee
    const chatsResult = await client.messaging.getAllChatsFromAttendee({
      attendee_id: attendeeId,
      account_id,
      limit: 1,
    });

    if (!chatsResult?.items?.length) {
      this.log('getMessagesWithContact: no chat found for attendee', { attendeeId, account_id });
      return [];
    }

    const chatId = chatsResult.items[0]?.id;
    // Defense-in-depth: never call getAllMessagesFromChat without a concrete chat_id.
    // An empty/undefined chat_id makes Unipile return account-wide messages, which would
    // dump unrelated conversations onto a single lead.
    if (!chatId) {
      this.log('getMessagesWithContact: resolved chat has no id', { attendeeId, account_id });
      return [];
    }
    this.log('getMessagesWithContact: found chat', { chatId, attendeeId });

    // Step 2: fetch messages from the chat — is_sender is correctly set by Unipile
    const MAX_PAGES = 10;
    const messages: any[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const params: any = { chat_id: chatId, limit: 100 };
      if (cursor) params.cursor = cursor;
      else if (opts?.after) params.after = opts.after;

      const result = await client.messaging.getAllMessagesFromChat(params);

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
   * Send a LinkedIn InMail to a profile (works for 2nd/3rd-degree connections).
   * Requires a LinkedIn Premium account with InMail credits.
   * @param accountId      - The Unipile account ID to send from.
   * @param profileUrlOrId - A LinkedIn profile URL OR a raw provider_id.
   * @param isUrl          - true if profileUrlOrId is a profile URL, false if it is already a provider_id.
   * @param subject        - Subject line for the InMail (required by LinkedIn).
   * @param messageText    - The InMail body.
   */
  async sendInMail(accountId: string, profileUrlOrId: string, isUrl: boolean, subject: string, messageText: string): Promise<any> {
    try {
      const providerId = await this.resolveProviderId(profileUrlOrId, isUrl, accountId);
      this.log(`Sending InMail`, { accountId, providerId, subject, messageLength: messageText.length });
      const client = await this.getClient();
      const res = await client.messaging.startNewChat({
        account_id: accountId,
        attendees_ids: [providerId],
        text: messageText,
        subject,
        options: {
          linkedin: {
            inmail: true,
          },
        },
      });
      this.log(`InMail sent successfully`, { accountId, providerId });
      return res;
    } catch (error: any) {
      return this.handleError(error, 'sendInMail');
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

  /**
   * Resolve a Unipile account_id for a given user.
   * 1. Uses the user's own connected Unipile account if available (no connectivity check).
   * 2. Falls back to a randomly-selected site-wide Unipile account configured in settings.
   * Returns null if no account can be found.
   */
  async resolveAccountId(userId: string): Promise<string | null> {
    // 1. User's own accounts — try ALL of them and return the first whose LinkedIn
    //    session is still live. A single disconnected account must not shadow a
    //    working one, nor force a needless fall-through to the shared site-wide
    //    pool: the user's own accounts are ALWAYS preferred, and only when EVERY
    //    one of them is dead do we move on to the site-wide accounts below.
    //    (Previously this returned the FIRST own account with no liveness check,
    //    so a dead first account failed the whole lookup even when the user had a
    //    second, working account. Mirrors resolveAccountIdForEnrichment.)
    try {
      const { getAccountsByUserId } = await import('./connectedAccountsDb');
      const accounts = await getAccountsByUserId(userId);
      const userAccounts = (accounts as any[]).filter((a) => a.platform === 'unipile' && a.account_id);
      for (const account of userAccounts) {
        if (await this.isAccountConnected(account.account_id)) {
          return account.account_id;
        }
        this.log(`User account ${account.account_id} is disconnected — trying next own account`);
      }
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

  /**
   * Resolve ONLY the user's own connected Unipile account_id — no site-wide
   * shared-account fallback.
   *
   * Use this for user-initiated CRM actions (LinkedIn message sync, sending a
   * connection invite) that must run from a LinkedIn sender the user has actually
   * configured. The site-wide shared pool used by `resolveAccountId` is for
   * background/system features (enrichment, drip sequences); borrowing one of
   * those accounts for a user's manual outreach would send from an account the
   * user never connected. Returns null when the user has no own Unipile account.
   */
  async resolveUserOwnedAccountId(userId: string): Promise<string | null> {
    try {
      const { getAccountsByUserId } = await import('./connectedAccountsDb');
      const accounts = await getAccountsByUserId(userId);
      const userAccount = (accounts as any[]).find((a) => a.platform === 'unipile');
      if (userAccount?.account_id) return userAccount.account_id;
    } catch { /* ignore */ }
    return null;
  }

  /**
   * List ALL of the user's own connected Unipile account_ids (no site-wide
   * shared pool). Where `resolveUserOwnedAccountId` returns just the first,
   * callers that must reason about ambiguity — e.g. "which account will
   * actually send?" — need the full set. Returns [] on any failure.
   */
  async listUserOwnedUnipileAccountIds(userId: string): Promise<string[]> {
    try {
      const { getAccountsByUserId } = await import('./connectedAccountsDb');
      const accounts = await getAccountsByUserId(userId);
      return (accounts as any[])
        .filter((a) => a.platform === 'unipile' && a.account_id)
        .map((a) => a.account_id as string);
    } catch { /* ignore */ }
    return [];
  }

  /**
   * Enrichment-specific account resolution. Differs from resolveAccountId in three ways:
   * 1. Tries ALL user accounts (not just the first), skipping dead ones with a connectivity check.
   * 2. Site-wide accounts are the last resort, never the first choice.
   * 3. Result cached per user for 1 hour; invalidated on NOT_FOUND errors via invalidateResolvedAccount().
   *
   * Pass `skipAccountIds` to exclude specific accounts (e.g. ones that returned 429 this run).
   * When skipAccountIds is non-empty the result is NOT cached (cache is per-user, not per-exclusion set).
   */
  async resolveAccountIdForEnrichment(userId: string, skipAccountIds?: Set<string>): Promise<string | null> {
    const skip = skipAccountIds && skipAccountIds.size > 0;
    if (!skip) {
      const cached = this.resolvedAccountCache.get(userId);
      if (cached && Date.now() - cached.timestamp < LinkedInOutreachService.RESOLVED_ACCOUNT_TTL_MS) {
        return cached.accountId;
      }
    }

    const setCache = (accountId: string) => {
      if (!skip) this.resolvedAccountCache.set(userId, { accountId, timestamp: Date.now() });
      return accountId;
    };

    // 1. User's own accounts — try all, first live one wins
    try {
      const { getAccountsByUserId } = await import('./connectedAccountsDb');
      const accounts = await getAccountsByUserId(userId);
      const userAccounts = (accounts as any[]).filter((a) => a.platform === 'unipile');
      for (const account of userAccounts) {
        if (!account.account_id) continue;
        if (skip && skipAccountIds!.has(account.account_id)) continue;
        if (await this.isAccountConnected(account.account_id)) {
          return setCache(account.account_id);
        }
      }
    } catch { /* ignore */ }

    // 2. Site-wide accounts (last resort) — verify connectivity before returning
    try {
      const { settingsService } = await import('./settingsService');
      const setting = await settingsService.getSetting('site-wide-unipile-accounts');
      if (setting?.settingValue) {
        const siteAccounts = JSON.parse(setting.settingValue);
        const enabled = (siteAccounts as any[]).filter((a) => a.enabled !== false);
        const shuffled = enabled.sort(() => Math.random() - 0.5);
        for (const account of shuffled) {
          if (skip && skipAccountIds!.has(account.account_id)) continue;
          if (await this.isAccountConnected(account.account_id)) {
            return setCache(account.account_id);
          }
          this.log(`Site-wide account ${account.account_id} (${account.account_name}) is disconnected — skipping`);
        }
      }
    } catch { /* ignore */ }

    return null;
  }
}

export const linkedInOutreachService = new LinkedInOutreachService();
