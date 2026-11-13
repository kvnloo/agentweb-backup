/**
 * Meta OAuth finalize + ad-account connect, shared by the portal routes (routes/metaAuth.ts:
 * POST /finalize, POST /connect-ad-accounts) and the Zoma server-side callback (ENG-2496).
 * Extracted verbatim from metaAuth.ts so both entry points run one implementation. Callers
 * own authentication and state verification; these functions trust the `userId` they get.
 */
import axios from 'axios';
import crypto from 'crypto';
import { getMetaCredentials, getInstagramCredentials } from '../utils/secretsManager';
import { getMetaFlowConfig, INTEGRATION_CONFIG, MetaFlowType } from '../config/integrations';
import { metaService } from './metaService';
import { instagramService } from './instagramService';
import { createAccount, getAccountById, type ConnectedAccount } from './connectedAccountsDb';
import { oauthSessionDb } from './db';
import { MetaAdAccount, MetaInstagramAccount } from '../types/meta';
import { raiseMetaConnectionHandoff, verifyMetaAdAccountReadBack } from './metaConnectionHandoff';
import { zomaMilestone } from './journeyMilestones';

export const META_PRECONNECT_INSTRUCTIONS =
    'Click Edit access, select all current and future Pages, approve all permissions.';

// Token sessions are stored in DynamoDB (AW-OAuthSessions) with a 10-minute TTL
// to survive across multiple backend instances behind the load balancer.

export interface MetaOAuthTokenSession {
    userId: string;
    access_token: string;
    expires_in?: number;
    scopes: string[];
    granted_scopes?: string[];
    declined_required_permissions?: string[];
    meta_oauth_health_error?: string;
    has_meta_pages?: boolean;
    meta_page_ids?: string[];
    meta_page_count?: number;
    meta_page_health_error?: string;
    flow: MetaFlowType;
}

async function storeTokenSession(userId: string, tokens: Omit<MetaOAuthTokenSession, 'userId'>): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    await oauthSessionDb.save({ sessionId, userId, ...tokens });
    return sessionId;
}

export async function retrieveTokenSession(sessionId: string, userId: string): Promise<MetaOAuthTokenSession | null> {
    const session = await oauthSessionDb.get(sessionId, userId) as MetaOAuthTokenSession | null;
    if (!session) {
        console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... not found or userId mismatch`);
        return null;
    }
    console.log(`[TokenSession] Retrieved session ${sessionId.substring(0, 8)}...`);
    return session;
}

/**
 * ENG-1644 gap-closing: if the customer had a pending reconnect decision for
 * this exact account, this real reconnect resolves it. Dynamic import —
 * approvalInboxCustomerNotify.ts transitively pulls in
 * emailService/chatbotService/agentModeService, too heavy to load statically
 * into this lightweight OAuth module. safeAutoResolveCredentialDecision
 * itself never throws, but the import statement can — own try/catch so that
 * can't abort a response after earlier accounts in the same loop already
 * connected.
 */
export async function safeAutoResolve(label: string, userId: string, platform: string, accountId: string): Promise<void> {
    try {
        const { safeAutoResolveCredentialDecision } = await import('./approvalInboxCustomerNotify');
        await safeAutoResolveCredentialDecision(label, userId, platform, accountId);
    } catch (err: any) {
        console.warn(`[${label}] auto-resolve module failed to load:`, err?.message || err);
    }
}

export type MetaFinalizeResult =
    | {
        flow: 'marketing';
        adAccounts?: MetaAdAccount[];
        adAccountsError?: boolean;
        hasMetaPages?: boolean;
        metaPageCount?: number;
        declinedRequiredPermissions?: string[];
        metaOAuthHealthError?: string;
        preconnectInstructions: string;
        tokenSessionId: string;
    }
    | { flow: 'instagram'; instagramAccounts?: MetaInstagramAccount[]; tokenSessionId: string };

/**
 * Exchange the OAuth code for a token, probe granted scopes / Page access, park the token in
 * a short-lived session bound to `userId`, and list the selectable accounts.
 */
export async function finalizeMetaOAuth(params: { userId: string; code: string; flow: MetaFlowType }): Promise<MetaFinalizeResult> {
    const { userId, code, flow } = params;
    // Use Instagram credentials for Instagram Business Login, Facebook App creds for marketing/pages
    const creds = flow === 'instagram'
        ? await getInstagramCredentials()
        : await getMetaCredentials();
    const flowCfg = getMetaFlowConfig(flow);
    const redirectUri = flow === 'instagram'
        ? INTEGRATION_CONFIG.meta.instagramRedirectUri
        : INTEGRATION_CONFIG.meta.redirectUri;
    const clientId = flow === 'instagram'
        ? creds.instagramClientId
        : creds.clientId;
    const clientSecret = flow === 'instagram'
        ? creds.instagramClientSecret
        : creds.clientSecret;
    console.log(`[Meta Finalize] flow=${flow} — exchanging code for token...`);

    // Exchange code for access token
    // Instagram Business Login requires POST with form-encoded body (not GET)
    // Facebook Login (marketing/pages) uses GET with query params
    let tokenResponse: any;
    if (flow === 'instagram') {
        const params = new URLSearchParams();
        params.append('client_id', clientId);
        params.append('client_secret', clientSecret);
        params.append('grant_type', 'authorization_code');
        params.append('redirect_uri', redirectUri);
        params.append('code', code);

        tokenResponse = await axios.post(flowCfg.tokenUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        });
    } else {
        tokenResponse = await axios.get(flowCfg.tokenUrl, {
            params: {
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
                redirect_uri: redirectUri,
                code
            },
            timeout: 15000
        });
    }

    let { access_token, expires_in } = tokenResponse.data as { access_token: string; expires_in?: number };

    if (flow === 'instagram') {
        try {
            console.log('[Meta Finalize] Exchanging short-lived Instagram token for a long-lived one...');
            const longLived = await instagramService.getLongLivedToken(access_token, clientSecret);
            if (longLived && longLived.access_token) {
                access_token = longLived.access_token;
                expires_in = longLived.expires_in;
                console.log(`[Meta Finalize] Successfully obtained long-lived token (expires_in: ${expires_in})`);
            }
        } catch (err: any) {
            console.warn('[Meta Finalize] Failed to exchange for long-lived token, falling back to short-lived:', err?.message || err);
        }
    }

    // Ask Meta what it ACTUALLY granted. `flowCfg.scopes` is only what we
    // requested — the user can untick individual permissions at the consent
    // dialog and still receive a token, so storing the request as if it were
    // the grant records an unverified claim (ENG-629 / OPS-79). Best-effort:
    // a failure here must never block connecting the account.
    let granted_scopes: string[] | undefined;
    let declined_required_permissions: string[] | undefined;
    let meta_oauth_health_error: string | undefined;
    try {
        granted_scopes = await metaService.getGrantedScopes(access_token);
        console.log(
            `[Meta Finalize] granted scopes: ${granted_scopes ? granted_scopes.join(',') : '(undetermined)'}`
        );
    } catch (err: any) {
        console.warn(`[Meta Finalize] Could not determine granted scopes: ${err?.message ?? err}`);
    }

    // ENG-2232: Page access is a second, independent Meta grant that
    // granted_scopes says nothing about — a token can hold ads_read with
    // zero accessible Pages, and every AD_CREATIVE needs a page_id. Probed
    // once here, at connect/reconnect time, same pattern as granted_scopes
    // above: best-effort, and `undefined` (never `false`) on failure so
    // "we could not ask" is never read as "confirmed zero Pages".
    let has_meta_pages: boolean | undefined;
    let meta_page_ids: string[] | undefined;
    let meta_page_count: number | undefined;
    let meta_page_health_error: string | undefined;
    if (flow === 'marketing') {
        try {
            const health = await metaService.checkOAuthConnectionHealth(access_token, flowCfg.scopes);
            granted_scopes = health.grantedPermissions.length > 0 ? health.grantedPermissions : granted_scopes;
            declined_required_permissions = health.declinedRequiredPermissions;
            meta_oauth_health_error = health.permissionsError;
            if (health.pagesError) {
                meta_page_health_error = health.pagesError;
                console.warn(`[Meta Finalize] Could not determine Page access: ${health.pagesError}`);
            } else {
                has_meta_pages = health.pageCount > 0;
                meta_page_count = health.pageCount;
                meta_page_ids = health.pageIds;
                console.log(`[Meta Finalize] has_meta_pages: ${has_meta_pages} (${health.pageCount} Page(s))`);
            }
        } catch (err: any) {
            console.warn(`[Meta Finalize] Could not determine Page access: ${err?.message ?? err}`);
            meta_page_health_error = err?.message ?? String(err);
        }
    }

    const tokenSessionId = await storeTokenSession(userId, {
        access_token,
        expires_in,
        scopes: flowCfg.scopes,
        ...(granted_scopes ? { granted_scopes } : {}),
        ...(declined_required_permissions ? { declined_required_permissions } : {}),
        ...(meta_oauth_health_error ? { meta_oauth_health_error } : {}),
        ...(has_meta_pages !== undefined ? { has_meta_pages } : {}),
        ...(meta_page_ids ? { meta_page_ids } : {}),
        ...(meta_page_count !== undefined ? { meta_page_count } : {}),
        ...(meta_page_health_error ? { meta_page_health_error } : {}),
        flow
    });

    if (flow === 'instagram') {
        let igAccount: MetaInstagramAccount | null = null;
        try {
            // Method C: fetch IG account from Instagram Graph API
            igAccount = await instagramService.getInstagramBusinessMe(access_token);
        } catch (error) {
            console.log('[Meta Finalize] Failed to fetch Instagram account:', error);
        }
        return { flow, instagramAccounts: igAccount ? [igAccount] : undefined, tokenSessionId };
    }

    let adAccounts: MetaAdAccount[] = [];
    let adAccountsError = false;
    try {
        adAccounts = await metaService.getAdAccounts(access_token);
        console.log(`[Meta Finalize] Found ${adAccounts.length} ad account(s) for user ${userId}`);
    } catch (error: any) {
        // Surface a flag (no details) so the caller can distinguish "Meta call
        // failed" from "user genuinely has zero ad accounts".
        adAccountsError = true;
        const structured = error?.structuredError;
        console.error(`[Meta Finalize] getAdAccounts failed for user ${userId}`, {
            code: structured?.code ?? null,
            classification: structured?.classification ?? null,
            message: error?.message ?? String(error),
            fbtrace_id: structured?.fbtrace_id ?? null,
        });
    }

    return {
        flow: 'marketing',
        adAccounts: adAccounts.length > 0 ? adAccounts : undefined,
        adAccountsError: adAccountsError || undefined,
        // ENG-2232: lets the frontend show a blocking warning on the
        // "Choose Pages" step before the user finishes connecting,
        // instead of only discovering this later at ad-creative time.
        hasMetaPages: has_meta_pages,
        metaPageCount: meta_page_count,
        declinedRequiredPermissions: declined_required_permissions,
        metaOAuthHealthError: meta_oauth_health_error || meta_page_health_error,
        preconnectInstructions: META_PRECONNECT_INSTRUCTIONS,
        tokenSessionId
    };
}

export type MetaAdAccountSelection = Pick<MetaAdAccount, 'account_id' | 'name' | 'currency' | 'account_status'>;

/** Thrown for an expired/foreign token session — callers map it to a 400. */
export class MetaTokenSessionError extends Error {
    constructor() {
        super('Invalid or expired token session');
        this.name = 'MetaTokenSessionError';
    }
}

/**
 * Store the selected ad accounts for `userId` using the token parked by finalizeMetaOAuth.
 * The token session is bound to `userId`, so a foreign session id throws MetaTokenSessionError.
 */
export async function connectMetaAdAccounts(params: {
    userId: string;
    customerEmail?: string;
    adAccounts: MetaAdAccountSelection[];
    tokenSessionId: string;
}): Promise<{ connectedAccounts: ConnectedAccount[]; accountsMissingPages: string[] }> {
    const { userId, adAccounts, tokenSessionId } = params;
    const session = await retrieveTokenSession(tokenSessionId, userId);
    if (!session) throw new MetaTokenSessionError();

    const connectedAccounts: ConnectedAccount[] = [];
    for (const adAccount of adAccounts) {
        // ENG-2232: createAccount replaces `config` wholesale on reconnect
        // (unlike top-level fields such as sharedWithOrg, which survive via
        // spread). A transient Page-probe failure on this reconnect would
        // otherwise silently erase a previously confirmed has_meta_pages:false
        // back to 'unknown'. Fall back to the existing account's recorded
        // value whenever this session's probe came back undetermined.
        //
        // Includes the legacy 'facebook' platform value alongside 'meta'
        // (code review follow-up) — getMetaCredentials elsewhere in this
        // codebase treats them as the same account for backward
        // compatibility with connections made before the platform name was
        // standardized; a lookup scoped to 'meta' alone would silently miss
        // the recorded value on any account still stored under the old name,
        // for precisely the users reconnecting because their ads are failing.
        const existingAccount = await getAccountById(adAccount.account_id, userId, ['meta', 'facebook'] as any);
        const existingConfig = existingAccount?.config as Record<string, any> | undefined;
        let has_meta_pages = session.has_meta_pages !== undefined
            ? session.has_meta_pages
            : existingConfig?.has_meta_pages;
        // Same fallback discipline as has_meta_pages above — read back by
        // getAccessiblePageIds, which a gate uses to check one SPECIFIC
        // page_id (e.g. an AD_CREATIVE CREATE call's target) rather than
        // only the aggregate boolean (ENG-2232).
        const accessible_page_ids: string[] | undefined = session.meta_page_ids !== undefined
            ? session.meta_page_ids
            : existingConfig?.accessible_page_ids;

        // ENG-2232: "this login can see at least one Page" isn't the same as
        // "this specific ad account's existing ads run under one of them" —
        // cross-check against what the account's own creatives actually use.
        // `getExistingAdPageIds` is itself best-effort (never throws, returns
        // [] on failure), so this only ever tightens a positive answer, never
        // loosens a negative one.
        let existing_ads_page_id: string | undefined;
        if (has_meta_pages === true && session.meta_page_ids) {
            const existingPageIds = await metaService.getExistingAdPageIds(
                adAccount.account_id,
                session.access_token
            );
            const accessiblePageIds = new Set(session.meta_page_ids);
            const uncovered = existingPageIds.filter(id => !accessiblePageIds.has(id));
            if (existingPageIds.length > 0 && uncovered.length === existingPageIds.length) {
                has_meta_pages = false;
                existing_ads_page_id = existingPageIds[0];
            }
        }

        const account = await createAccount(userId, 'meta', {
            account_id: adAccount.account_id,
            account_name: adAccount.name,
            config: {
                account_type: 'ad_account',
                ad_account_id: adAccount.account_id,
                currency: adAccount.currency,
                account_status: adAccount.account_status,
                access_token: session.access_token,
                token_expires_at: session.expires_in ? Date.now() + (session.expires_in * 1000) : Date.now() + (60 * 24 * 60 * 60 * 1000),
                scopes: session.scopes,
                // Authoritative capability signal, read back by getMetaAdsScopeState.
                // Omitted (not []) when undetermined, so "we could not ask" never
                // masquerades as "nothing was granted" (ENG-629).
                ...(session.granted_scopes ? { granted_scopes: session.granted_scopes } : {}),
                ...(session.declined_required_permissions ? { declined_required_permissions: session.declined_required_permissions } : {}),
                ...(session.meta_oauth_health_error ? { meta_oauth_health_error: session.meta_oauth_health_error } : {}),
                // Authoritative Page-access signal, read back by getMetaPagesAccessState.
                // Falls back to the previously recorded value on an undetermined
                // probe so a transient failure can't revert a confirmed value
                // back to unknown (ENG-2232).
                ...(has_meta_pages !== undefined ? { has_meta_pages } : {}),
                ...(session.meta_page_count !== undefined ? { meta_page_count: session.meta_page_count } : {}),
                ...(session.meta_page_health_error ? { meta_page_health_error: session.meta_page_health_error } : {}),
                // Names the specific Page this account's existing ads use, when the
                // reason has_meta_pages is false is a wrong-Page mismatch rather than
                // zero Pages — read back by getMetaAdsNoPagesMessage (ENG-2232).
                ...(existing_ads_page_id ? { existing_ads_page_id } : {}),
                // The actual accessible Page ids, read back by getAccessiblePageIds
                // for the AD_CREATIVE CREATE page_id gate (ENG-2232).
                ...(accessible_page_ids !== undefined ? { accessible_page_ids } : {}),
            }
        });
        connectedAccounts.push(account);

        // ENG-1986: post-reconnect read-back — a 200 from OAuth is not proof the
        // credential reads the account. Best-effort; never fails the connect.
        const readBack = await verifyMetaAdAccountReadBack(adAccount.account_id, session.access_token);
        if (!readBack.ok) {
            await raiseMetaConnectionHandoff({
                reason: 'reconnect_readback_failed',
                userId,
                customerEmail: params.customerEmail,
                account,
                error: readBack.error || 'read-back failed',
            });
        } else {
            await safeAutoResolve('Meta Connect Ad Accounts', userId, 'meta', adAccount.account_id);
        }
    }

    // ENG-2232: names which of the just-connected accounts have no accessible
    // Facebook Page, so the UI can warn right now instead of leaving the user
    // with a plain "Connected!" toast that reads as "you're all set" — Page
    // access is a second, independent Meta grant that won't be revisited until
    // the twice-daily reconciler or a future chat session's PAGE LIST call.
    const accountsMissingPages = connectedAccounts
        .filter(acc => (acc.config as Record<string, any> | undefined)?.has_meta_pages === false)
        .map(acc => acc.account_name);

    // ENG-2906: shared by the portal and Zoma setup. Journey event always; zomaStage only for
    // users who already use Zoma. Fire-and-forget, never affects the connect result.
    if (connectedAccounts.length > 0) {
        void zomaMilestone(userId, 'meta_connected', { emit: 'always', requireZoma: true, props: { platform: 'meta' } });
    }

    return { connectedAccounts, accountsMissingPages };
}
