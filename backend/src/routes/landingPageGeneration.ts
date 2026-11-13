import { Router, Request, Response, NextFunction } from "express";
import { emitLanderLifecycle, landerChannelFromRequest } from "../services/landerLifecycleEvents";
import axios from "axios";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { settingsService } from "../services/settingsService";
import { userDb, orgDb, crmDb } from "../services/db";
import { resolveOrgProfileField } from "../services/orgProfileResolver";
import {
  publishWithdrawnMidFlight,
  publishRevalidationForForwardedRun,
} from "../utils/scheduledPublishConsentGuard";
import {
  generateLandingPage,
  deployLandingPage,
  iterateLandingPage,
  getLandingPage,
  getLandingPageById,
  getLandingPagesByOwner,
  getLandingPagesByOrg,
  listLandingPages,
  deleteLandingPage,
  deleteLandingPageByRecord,
  updateLandingPageGtm,
  BrandContext,
  buildBrandContextFromUser,
  GeneratedLandingPage,
  getDeploymentStatus,
  getPreviewDeploymentUrl,
  triggerVercelDeployment,
  resolveVercelProjectId,
  extractTemplateOutline,
  getProjectEnvVars,
  upsertEnvVar,
  deleteEnvVar,
  updateLandingPageContext,
  updateLandingPageLeadList,
  syncLeadCaptureFilesToRepo,
  NO_CAPTURE_LAYER,
  recordLandingPagePublish,
  markLandingPagePublishReverted,
  INTEGRATIONS,
  resolveSiteForCaller,
  resolveLockedSiteMode,
  resolveLandingPageLiveUrl,
  canUserEditLandingPage,
  updateLandingPageTrackingInstalled,
  updateLandingPageGoogleAds,
  updateLandingPageGoogleAdsInstalled,
  updateLandingPageMetaPixel,
  updateLandingPageMetaTrackingInstalled,
  buildCaptureRoute,
  commitFilesToRepoMain,
} from "../services/v0Service";
import { injectGtmIntoLayout, verifyGtmInjection } from "../utils/gtmInjection";
import { injectGoogleAdsIntoLayout, verifyGoogleAdsInjection } from "../utils/googleAdsInjection";
import { injectPixelIntoLayout, verifyPixelInjection } from "../utils/pixelInjection";
import { SessionTrackingError, disableSessionTrackingForPage, enableSessionTrackingForPage } from "../services/sessionTrackingService";
import { canEditItem, canViewItem, canManageOrgFeature, isFeatureEffectivelyEnabled } from "../services/orgShareService";
import { MISSING_BRAND_LOGO_ERROR } from "../services/agentMode/brandLogo";
import { isSessionList, SESSION_LIST_LEAD_CAPTURE_ERROR } from "../utils/sessionList";
import { listDomains, CustomDomainRecord, SUBDOMAIN_BASE } from "../services/customDomainService";
import { isExternalLandingPageRecord } from "../services/externalLandingPageCatalog";
import { verifyLanderLiveMapping } from "../services/landerLiveMappingCheck";
import { assertOwnedMetaPixel } from "../services/metaAccountCredentials";
import { evaluateRequiredTestsGate } from "../services/publishGateVerifier";

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_INPUT_LENGTH = 10_000;

// Expensive operations (v0 generation, deploy, iterate) — costs real credits
const GENERATION_RATE_LIMIT_MAX = 10;
const GENERATION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Cheap operations (GitHub file edits) — just API calls, no credit cost
const EDIT_RATE_LIMIT_MAX = 60;
const EDIT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const REUSABLE_PREVIEW_BRANCH = "draft/agentweb-preview";

const DEFAULT_LANDING_PAGE_LEAD_LIST_NAME = "Landing Page Leads";

// Singleflight for default-list resolution, keyed by orgId-or-userId (the same
// identity boundary the org-shared list lookup uses). Prod runs a single backend
// instance today (verified 2026-07-24), so this fully closes the double-click /
// two-tabs / two-org-members-simultaneously-generating race — two concurrent
// callers sharing a key join the SAME resolve-or-create call instead of each
// racing to create their own default list. Same scope caveat as the analogous
// fix in metaTokenRefresh.ts: per-process only, revisit if ever scaled to 2+ instances.
const inFlightDefaultListResolutions = new Map<string, Promise<{ id: string; publicAccessEnabled: boolean }>>();

async function resolveDefaultListOnce(userId: string): Promise<{ id: string; publicAccessEnabled: boolean }> {
  // Only match a list WE created (isSystemManaged), never an unrelated pre-existing
  // list a user happens to have named the same thing — a name-only match could
  // silently start routing landing-page leads into a list the user made for some
  // other purpose. isSystemManaged is only ever set by this function's own create call.
  const existing = await crmDb.getLeadListsForUser(userId);
  const match = (existing || []).find(
    (l: any) => l && l.isSystemManaged === true && l.name === DEFAULT_LANDING_PAGE_LEAD_LIST_NAME
  );
  if (match) {
    return { id: match.listId, publicAccessEnabled: !!match.publicAccessEnabled };
  }
  console.log(`[LP GENERATION] No default lead list found for user ${userId} — creating "${DEFAULT_LANDING_PAGE_LEAD_LIST_NAME}"`);
  const created = await crmDb.createLeadList(
    userId,
    DEFAULT_LANDING_PAGE_LEAD_LIST_NAME,
    "Auto-created default list for landing pages generated without an explicit lead list. System-managed.",
    undefined, // alertEvents
    null, // listSenderId
    undefined, // autoDraftEnabled
    undefined, // autoDraftInstruction
    undefined, // autoSendEnabled
    undefined, // statusConfig — defaults to sales-style
    "sales", // listType
    true // isSystemManaged
  );
  return { id: (created as any).listId, publicAccessEnabled: !!(created as any).publicAccessEnabled };
}

/**
 * ENG-449 capture-or-fail: resolve (or create) the default lead list a landing
 * page generated with no explicit lead_list_id gets bound to, so no page is ever
 * generated unbound. Idempotent by name+isSystemManaged, org-aware (mirrors
 * signupAutoEnrollService's ensureFoundersSignupsList pattern) — org members
 * share ONE default list rather than one each, consistent with how brand
 * guidelines are already org-shared in this same route.
 *
 * Retries once on failure (transient DynamoDB blips happen) before giving up —
 * but deliberately does NOT swallow a persistent failure and fall back to
 * "proceed unbound": that would silently reintroduce the exact bug this fix
 * exists to close. A persistent failure here is meant to fail the generation
 * request loudly, not slip an unbound page through.
 */
async function resolveOrCreateDefaultLeadList(
  userId: string,
  orgId?: string
): Promise<{ id: string; publicAccessEnabled: boolean }> {
  const key = orgId || userId;
  let inFlight = inFlightDefaultListResolutions.get(key);
  if (!inFlight) {
    inFlight = (async () => {
      try {
        return await resolveDefaultListOnce(userId);
      } catch (firstError) {
        console.warn(`[LP GENERATION] Default lead list resolution failed once, retrying:`, firstError);
        return await resolveDefaultListOnce(userId);
      }
    })();
    inFlightDefaultListResolutions.set(key, inFlight);
    // .finally()'s returned promise re-throws on rejection — if left unhandled (and
    // uncaught, since the ORIGINAL inFlight's rejection is separately handled by
    // whoever awaits resolveOrCreateDefaultLeadList), it surfaces as an unhandled
    // promise rejection. The cleanup itself can't fail (a synchronous Map.delete).
    inFlight.finally(() => inFlightDefaultListResolutions.delete(key)).catch(() => {});
  }
  return inFlight;
}

/**
 * ENG-967: a lead list a landing page is bound to MUST be able to RECEIVE that page's
 * submissions. The generated capture route posts to /api/webhooks/forward-lead, which
 * rejects any list with `publicAccessEnabled !== true` with a 403 — and the visitor is
 * still shown a success screen. Binding a private list therefore produces a page that
 * reports "saving leads to X" while silently dropping every submission, forever.
 *
 * /generate has enabled public access on the list it binds since ENG-449, but the two
 * OTHER paths that bind a list did not: PATCH /generated/:id/lead-list (the portal's
 * lead-list picker and the agent's MCP equivalent) and /generated/:id/duplicate. A list
 * created anywhere else — crmDb.createLeadList defaults publicAccessEnabled to false,
 * including the auto-provisioned default list — stayed private, so those two paths wired
 * up a page whose form could never save a lead.
 *
 * Idempotent (no write when the list is already public) and never throws: it returns a
 * warning string instead, so a caller can tell the user the truth rather than report a
 * clean save.
 *
 * A MISSING list is a warning, not a success. `getLeadListById` returns null for a record
 * that no longer exists, and a page bound to one POSTs into a 404 at forward-lead — the same
 * silent drop, one step further along. This is not hypothetical: a read of all 167
 * AW-LandingPages records on 2026-08-21 found three bound lists absent from AW-LeadLists.
 * Nothing here can repair that (repointing a page at a different list is a judgement call),
 * so it is reported rather than guessed at.
 *
 * @returns undefined when the list accepts public submissions, else a warning message.
 */
async function ensureLeadListAcceptsPublicSubmissions(leadListId: string): Promise<string | undefined> {
  try {
    const list = await crmDb.getLeadListById(leadListId);
    if (!list) {
      console.warn(`[LP GENERATION] Bound lead list ${leadListId} does not exist`);
      return (
        `Lead list ${leadListId} no longer exists, so this page's form has nowhere to save a ` +
        "lead and every submission will be rejected. Attach an existing list to this page in CRM."
      );
    }
    if (list.publicAccessEnabled) return undefined;
    await crmDb.updateLeadList(leadListId, { publicAccessEnabled: true });
    console.log(`[LP GENERATION] Auto-enabled public access on lead list ${leadListId}`);
    return undefined;
  } catch (err) {
    console.warn(`[LP GENERATION] Could not auto-enable public access on lead list ${leadListId}:`, err);
    return (
      "Lead list saved, but public form submissions could not be enabled on it, so this page's " +
      "form will keep rejecting every lead. Enable public access on the list in CRM settings."
    );
  }
}

function validateBranchName(branch: string): boolean {
  return branch === "main" || branch === REUSABLE_PREVIEW_BRANCH;
}

/**
 * Fetch a landing page and authorize the caller for view or edit.
 * Owner always passes. Otherwise checks shareSettings.landingPages via
 * canViewItem (read endpoints) or canEditItem (write endpoints), which
 * permits editors listed in shareSettings.landingPages.editors and the
 * org owner. Editors are still denied delete elsewhere (owner-only).
 *
 * On non-owner view denial we return 404 (not 403) to avoid leaking
 * existence of pages outside the caller's scope.
 */
async function authorizeLandingPageAccess(
  pageId: string,
  callerUserId: string,
  mode: "view" | "edit",
): Promise<
  | { ok: true; page: GeneratedLandingPage }
  | { ok: false; status: number; error: string }
> {
  const page = await getLandingPageById(pageId);
  if (!page) return { ok: false, status: 404, error: "Landing page not found" };
  if (page.userId === callerUserId) return { ok: true, page };

  const [user, pageOwner] = await Promise.all([
    userDb.getUserById(callerUserId),
    userDb.getUserById(page.userId),
  ]);
  const ownerOrgId = pageOwner?.orgId;
  const org =
    user?.orgId && user.orgId === ownerOrgId
      ? await orgDb.getOrgById(user.orgId)
      : null;
  const callerLike = {
    userId: callerUserId,
    orgId: user?.orgId,
    orgRole: user?.orgRole as "owner" | "member" | undefined,
  };
  const itemLike = { userId: page.userId };
  const allowed =
    mode === "edit"
      ? canEditItem(itemLike, callerLike, org, ownerOrgId, "landingPages")
      : canViewItem(itemLike, callerLike, org, ownerOrgId, "landingPages");
  if (!allowed) {
    return mode === "edit"
      ? { ok: false, status: 403, error: "Not authorized to edit this landing page" }
      : { ok: false, status: 404, error: "Landing page not found" };
  }
  return { ok: true, page };
}

/**
 * Ensure a branch exists in the repo. Creates it from main's HEAD if missing.
 * No-op if the branch already exists.
 */
/**
 * Ensure a branch exists, creating it from main if needed.
 * Returns true if the branch was just created (callers may need to
 * account for GitHub eventual-consistency delays).
 */
async function ensureBranchExists(
  repoBase: string,
  branch: string,
  ghHeaders: Record<string, string>,
  timeoutMs: number
): Promise<boolean> {
  if (branch === "main") return false;

  try {
    await axios.get<any>(`${repoBase}/git/ref/heads/${branch}`, {
      headers: ghHeaders, timeout: timeoutMs,
    });
    // Branch exists
    return false;
  } catch (err: any) {
    if (err.response?.status === 404) {
      // Branch doesn't exist — create from main HEAD
      const mainRef = await axios.get<any>(`${repoBase}/git/ref/heads/main`, {
        headers: ghHeaders, timeout: timeoutMs,
      });
      const mainSha = mainRef.data.object.sha;
      await axios.post<any>(`${repoBase}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: mainSha,
      }, { headers: ghHeaders, timeout: timeoutMs });
      console.log(`[LP GENERATION] Created branch ${branch} from main (${mainSha.substring(0, 7)})`);
      return true;
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory per-user rate limiters
// ---------------------------------------------------------------------------
const generationRateLimitMap = new Map<string, number[]>();
const editRateLimitMap = new Map<string, number[]>();

/** @deprecated Use _resetRateLimitState instead — kept for backward compat */
export const rateLimitMap = generationRateLimitMap;

/** Exported for testing — allows tests to clear state between runs. */
export function _resetRateLimitState(): void {
  generationRateLimitMap.clear();
  editRateLimitMap.clear();
}

function createRateLimiter(
  map: Map<string, number[]>,
  max: number,
  windowMs: number,
  label: string
) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      next();
      return;
    }

    const now = Date.now();
    const timestamps = map.get(userId) || [];
    const recent = timestamps.filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const oldestInWindow = Math.min(...recent);
      const resetInSec = Math.ceil((oldestInWindow + windowMs - now) / 1000);
      res.status(429).json({
        error: `Rate limit exceeded. Max ${max} ${label} requests per hour.`,
        retry_after_seconds: resetInSec,
        limit: max,
        remaining: 0,
      });
      return;
    }

    // Only count the request against the limit AFTER the response succeeds.
    // Failed requests (5xx) should not consume rate limit quota — this prevents
    // a death spiral where transient errors eat up the user's limit on retries.
    const originalEnd = res.end;
    const originalJson = res.json;
    let counted = false;

    const countIfSuccess = () => {
      if (!counted) {
        counted = true;
        if (res.statusCode < 500) {
          recent.push(now);
          map.set(userId, recent);
        }
      }
    };

    res.end = function (this: any, ...args: any[]) {
      countIfSuccess();
      return (originalEnd as Function).apply(this, args);
    } as any;

    res.json = function (this: any, body: any) {
      countIfSuccess();
      return (originalJson as Function).call(this, body);
    } as any;

    next();
  };
}

const rateLimiter = createRateLimiter(
  generationRateLimitMap, GENERATION_RATE_LIMIT_MAX, GENERATION_RATE_LIMIT_WINDOW_MS, "generation"
);
const editRateLimiter = createRateLimiter(
  editRateLimitMap, EDIT_RATE_LIMIT_MAX, EDIT_RATE_LIMIT_WINDOW_MS, "file edit"
);

router.use(authenticateToken);

/**
 * GET /api/landing-pages/v0/site
 * Returns the caller's root landing site and its deploy status.
 */
router.get("/site", async (req: Request, res: Response) => {
  try {
    const callerUserId = (req as unknown as AuthenticatedRequest).user!.userId;
    const site = await resolveSiteForCaller(callerUserId);
    if (!site) {
      return res.status(404).json({
        deployStatus: "no_site",
        error: "No landing site found. Create a page first.",
      });
    }
    let deployStatus: "deploying" | "ready" | "failed";
    if (site.status === "failed") deployStatus = "failed";
    else if (site.vercelProjectId && site.githubRepoUrl) deployStatus = "ready";
    else deployStatus = "deploying";
    return res.json({
      rootPageId: site.id,
      vercelProjectId: site.vercelProjectId,
      githubRepoUrl: site.githubRepoUrl,
      gtmContainerId: site.gtmContainerId,
      /*
       * ENG-1527. The site's Google Ads conversion tag, alongside the GTM container it
       * sits next to on the record.
       *
       * The record has carried these since the tag work landed; this endpoint projected a
       * fixed five fields and dropped them, so the only way to see whether a site's
       * conversion tag exists was to read DynamoDB. That is the same class of gap as a
       * warning computed and discarded: the data is right there and nobody can see it.
       *
       * `googleAdsTrackingInstalled` is the one that matters most and is deliberately
       * normalised to a boolean rather than passed through as possibly-undefined. Undefined
       * means "we never recorded an outcome", which a UI would render the same as `false`
       * anyway; collapsing it here keeps every consumer from having to decide. It carries
       * more weight than its Meta sibling because Google has no server-side leg until
       * ENG-1325 — false means the lander shipped with NO Google measurement at all, which
       * is exactly what RULE 7.5 refuses a launch over.
       */
      googleAdsConversionId: site.googleAdsConversionId,
      googleAdsConversionLabel: site.googleAdsConversionLabel,
      googleAdsCustomerId: site.googleAdsCustomerId,
      googleAdsTrackingInstalled: site.googleAdsTrackingInstalled === true,
      deployStatus,
    });
  } catch (err) {
    console.error("GET /site failed:", err);
    return res.status(500).json({ error: "Failed to load site" });
  }
});

/** Real session ids are uuids (36 chars); DynamoDB rejects a key over 2048 bytes with a ValidationException. */
const MAX_ORIGINATING_SESSION_ID_LENGTH = 200;

/**
 * ENG-2651: the chat a generated page reports back to. The page record carries it as
 * `originatingSessionId`, which (a) durableLandingService.postToSession appends the completion /
 * failure message to, and (b) the auto human-eval candidate (v0Service.enqueueLandingPageHumanEval)
 * mints an iShare link for. Only a chat the caller may open qualifies: its owner, or an admin (the
 * agentModeController.getSession / routes/emmaApi.ts rule; a delegate token resolves `req.user` to the
 * target account). Anything else is dropped, never refused: the MCP tool sends `context.sessionId`,
 * which for an external MCP client is the MCP transport session id rather than a chat, and generation
 * without a chat to report to is the existing behaviour for that case.
 */
async function resolveOriginatingSessionId(
  originatingSessionId: unknown,
  caller: { userId?: string; isAdmin?: boolean } | undefined,
): Promise<string | undefined> {
  if (typeof originatingSessionId !== "string" || !originatingSessionId.trim()) return undefined;
  if (originatingSessionId.length > MAX_ORIGINATING_SESSION_ID_LENGTH) return undefined;
  let session;
  try {
    const { chatbotDb } = await import("../services/chatbotService");
    session = await chatbotDb.getChatSessionRecord(originatingSessionId, true);
  } catch (err: any) {
    // Never fail a generation over its optional report-back chat: drop it, like any unusable id.
    console.warn(`[LP GENERATION] could not read originating session, generating without it: ${err?.message}`);
    return undefined;
  }
  if (!session) return undefined;
  const isOwner = !!caller?.userId && session.userId === caller.userId;
  if (isOwner || caller?.isAdmin === true) return originatingSessionId;
  console.warn(`[LP GENERATION] ignoring originating_session_id owned by another account (caller ${caller?.userId})`);
  return undefined;
}

/**
 * POST /api/landing-pages/v0/generate
 * Generate a new landing page using v0 Platform API + brand guidelines
 */
router.post("/generate", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Org-level create gating: in an org, only the org owner or a listed
    // editor (when landingPages sharing is enabled) may generate new pages.
    // The org record is also the brand source for org members below.
    const caller = await userDb.getUserById(userId);
    const callerOrg = caller?.orgId ? await orgDb.getOrgById(caller.orgId) : null;
    if (caller?.orgId) {
      const allowed = canManageOrgFeature(
        { userId, orgId: caller.orgId, orgRole: caller.orgRole as "owner" | "member" | undefined },
        callerOrg,
        "landingPages",
      );
      if (!allowed) {
        return res.status(403).json({ error: "Landing pages are managed by your org admin" });
      }
    }

    const { prompt, name, lead_list_id, template_html: rawTemplateHtml, template_id, site_id, originating_session_id, mode: requestedMode, bridge_out_url, meta_pixel_override, google_ads } = req.body;
    // Condense uploaded HTML to avoid exceeding v0 prompt size limits
    let template_html: string | undefined = rawTemplateHtml
      ? extractTemplateOutline(rawTemplateHtml)
      : undefined;

    // ENG-449 (Harsha, 2026-07-24): a bridge-out destination is a THIRD-PARTY URL the
    // generated form redirects to after capturing the lead (e.g. an external booking
    // page) — a malformed destination would silently break that customer's funnel, so
    // fail loud here rather than generate a page whose redirect goes nowhere useful.
    if (bridge_out_url !== undefined && bridge_out_url !== null) {
      if (typeof bridge_out_url !== "string") {
        return res.status(400).json({ error: "bridge_out_url must be a string" });
      }
      try {
        const parsed = new URL(bridge_out_url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("not http(s)");
        }
      } catch {
        return res.status(400).json({ error: "bridge_out_url must be a well-formed http(s) URL" });
      }
    }

    // ENG-1141: an explicit pixel/account choice from the creation form's mandatory
    // picker (shown only when the customer's Meta connections are genuinely
    // ambiguous). Never trusts the client — assertOwnedMetaPixel re-validates the
    // pair belongs to the caller's own connected Meta accounts before it's allowed
    // to influence generation, same check the Calendly attribution route reuses.
    let metaPixelOverride: { pixelId: string; accountId: string } | undefined;
    if (meta_pixel_override !== undefined && meta_pixel_override !== null) {
      if (
        typeof meta_pixel_override !== "object" ||
        typeof meta_pixel_override.pixelId !== "string" || !meta_pixel_override.pixelId ||
        typeof meta_pixel_override.accountId !== "string" || !meta_pixel_override.accountId
      ) {
        return res.status(400).json({ error: "meta_pixel_override must be an object with pixelId and accountId" });
      }
      try {
        const { accountId: resolvedAccountId } = await assertOwnedMetaPixel(
          caller, userId, meta_pixel_override.pixelId, meta_pixel_override.accountId
        );
        metaPixelOverride = { pixelId: meta_pixel_override.pixelId, accountId: resolvedAccountId };
      } catch (err: any) {
        if (err?.ownershipViolation) {
          // The customer picked something that isn't theirs — a real rejection.
          return res.status(400).json({ error: err?.message || "Invalid meta_pixel_override" });
        }
        // Anything else means we couldn't REACH Meta to verify (Graph down, expired token,
        // network). Failing here would block page generation entirely on Meta's uptime — a
        // much worse outcome than shipping the page and resolving tracking normally, which is
        // exactly what happened before this option existed. Degrade, don't block.
        console.warn(
          `[LP GENERATION] Could not verify meta_pixel_override for user ${userId} ` +
          `(continuing without it): ${err?.message}`,
        );
        metaPixelOverride = undefined;
      }
    }

    /*
     * ENG-1328 AC1: the site's Google Ads conversion action, supplied at creation so the
     * base gtag ships in the FIRST commit rather than needing a follow-up call to the
     * manual endpoint. Without this the parameter threaded through
     * GenerateLandingPageOptions was unreachable — every generated lander shipped
     * untagged and AC1 could not happen at all.
     *
     * Never trusts the client, same stance as meta_pixel_override: the customer id has to
     * be one of the caller's own connected Google Ads accounts, or a request could point a
     * lander's conversions at an account the caller does not own.
     *
     * Both halves or neither. An id without its label fires a conversion that matches no
     * conversion action — reported as fired, attributing nothing.
     */
    let googleAds: { conversionId: string; conversionLabel: string; customerId?: string } | undefined;
    if (google_ads !== undefined && google_ads !== null) {
      if (
        typeof google_ads !== "object" ||
        typeof google_ads.conversionId !== "string" || !google_ads.conversionId.trim() ||
        typeof google_ads.conversionLabel !== "string" || !google_ads.conversionLabel.trim()
      ) {
        return res.status(400).json({ error: "google_ads must be an object with conversionId and conversionLabel" });
      }
      const conversionId = google_ads.conversionId.trim();
      // Same shape RULE 7.5's detector looks for, so a tag we install is a tag the
      // pre-flight gate will recognise on the served page.
      if (!/^AW-[0-9]{6,}$/.test(conversionId)) {
        return res.status(400).json({ error: "google_ads.conversionId must look like AW-123456789" });
      }
      let customerId: string | undefined;
      if (google_ads.customerId !== undefined && google_ads.customerId !== null) {
        if (typeof google_ads.customerId !== "string" || !google_ads.customerId.trim()) {
          return res.status(400).json({ error: "google_ads.customerId must be a string" });
        }
        customerId = google_ads.customerId.trim();
        const { getAccountsWithOwnerIncludingOrgShared } = await import("../services/connectedAccountsDb");
        const owned = (await getAccountsWithOwnerIncludingOrgShared(userId))
          .some((a: any) => a.platform === "google_ads" && a.config?.customer_id === customerId);
        if (!owned) {
          return res.status(400).json({ error: "google_ads.customerId is not one of your connected Google Ads accounts" });
        }
      }
      googleAds = { conversionId, conversionLabel: google_ads.conversionLabel.trim(), customerId };
    }

    // If template_id provided (user picked a template), look it up from DynamoDB
    if (template_id && !template_html) {
      const lookupKeys = [
        `templates_${userId}`,
        'templates_public',
      ];
      let found = false;
      for (const key of lookupKeys) {
        try {
          const setting = await settingsService.getSetting(key);
          if (!setting?.settingValue) continue;
          const arr: any[] = JSON.parse(setting.settingValue);
          const match = arr.find((t: any) => t.template_id === template_id);
          if (match?.html_content) {
            template_html = extractTemplateOutline(match.html_content);
            console.log(`[LP GENERATION] Loaded template "${template_id}" from ${key} (${template_html?.length} chars condensed)`);
            found = true;
            break;
          }
        } catch {
          // continue to next key
        }
      }
      if (!found) {
        console.warn(`[LP GENERATION] Template "${template_id}" not found in any DynamoDB key, continuing without template`);
      }
    }

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required and must be a string" });
    }

    if (prompt.length > MAX_INPUT_LENGTH) {
      return res.status(400).json({ error: `prompt must not exceed ${MAX_INPUT_LENGTH} characters` });
    }

    // ENG-449 (Harsha, 2026-07-24) capture-or-fail, explicit lead_list_id case: if the
    // caller names a specific list, it must actually exist — that's a genuine bad-input
    // error, fail loud. (The no-list-given case is handled AFTER the brand-logo gate
    // below, since it may provision a list — a real side effect that must not happen
    // on a request that's about to be rejected for an unrelated reason.)
    if (lead_list_id !== undefined && lead_list_id !== null && lead_list_id !== "") {
      if (typeof lead_list_id !== "string") {
        return res.status(400).json({ error: "lead_list_id must be a string" });
      }
      const explicitList = await crmDb.getLeadListById(lead_list_id);
      if (!explicitList) {
        return res.status(400).json({ error: `lead_list_id "${lead_list_id}" does not exist` });
      }
      if (!(await crmDb.canOrgMemberAccessList(userId, explicitList))) {
        return res.status(403).json({ error: `lead_list_id "${lead_list_id}" is not accessible to you` });
      }
      // ENG-2323: a session (telemetry) list is never a page's lead list.
      if (isSessionList(explicitList)) {
        return res.status(400).json({ error: SESSION_LIST_LEAD_CAPTURE_ERROR });
      }
    }

    const pageName = name || prompt.slice(0, 60);

    // Brand guidelines + market strategy for maximum context. The shared
    // projection resolves the persisted brand logo attachments-first and
    // org-aware — an org member's brand (incl. the uploaded logo) lives on
    // the ORG record (ENG-326), falling back to the org owner's record when
    // the org was never populated (ENG-927). Pure projection otherwise.
    const brandContext: BrandContext = buildBrandContextFromUser(
      caller,
      callerOrg
        ? await resolveOrgProfileField(caller, callerOrg, "brandGuidelines")
        : undefined,
      callerOrg,
    );
    const userSiteMode: "unified" | "separate" | undefined = caller?.landingSiteMode;

    // ENG-326 AC-3: landing pages are BRANDED assets — without a persisted
    // logo v0 renders an invented/approximate wordmark, the exact defect the
    // issue names. Point the user at brand config instead of generating.
    // Gate BEFORE any side effect (lead-list flip, site-mode lock).
    if (!brandContext.logoUrl) {
      return res.status(422).json({
        error: MISSING_BRAND_LOGO_ERROR,
        message:
          "No brand logo is saved in Brand Guidelines. Upload your logo in brand config " +
          "(Brand Guidelines), then generate again — landing pages are never generated " +
          "with an invented or approximate logo.",
      });
    }

    // ENG-449 capture-or-fail: every generated page ships bound to a REAL lead list —
    // either the caller's explicit one (already validated to exist above) or, if none
    // was given, an auto-resolved/created default. No page is ever generated unbound.
    // Placed AFTER the brand-logo gate so a request that's about to be rejected for an
    // unrelated reason never triggers the (write) side effect of provisioning a list.
    const effectiveLeadListId: string =
      typeof lead_list_id === "string" && lead_list_id !== ""
        ? lead_list_id
        : (await resolveOrCreateDefaultLeadList(userId, caller?.orgId)).id;

    // Auto-enable public access on the lead list so the landing page form works.
    // Only the enabling WRITE is best-effort here: a transient DB hiccup on this side
    // effect shouldn't block generation (unlike a genuinely missing explicit list) — but
    // it is REPORTED rather than discarded, or a page whose form cannot save a lead is
    // handed back as an unqualified success.
    const leadListWarning = await ensureLeadListAcceptsPublicSubmissions(effectiveLeadListId);

    // Effective site mode, WRITE-ONCE locked. A saved mode is immutable (switching
    // single<->multi would re-home deployed pages across repos/domains); the first
    // explicit pick sets + locks it; otherwise default unified.
    const { mode: effectiveMode, lockNow } = resolveLockedSiteMode(userSiteMode, requestedMode);
    if (lockNow) {
      await userDb
        .setLandingSiteMode(userId, effectiveMode)
        .catch((e) => console.warn(`[LP GENERATION] could not lock site mode: ${e?.message}`));
    }

    const originatingSessionId = await resolveOriginatingSessionId(
      originating_session_id,
      (req as unknown as AuthenticatedRequest).user,
    );

    const result = await generateLandingPage(userId, prompt, pageName, brandContext, effectiveLeadListId, template_html, {
      siteId: typeof site_id === "string" ? site_id : undefined,
      originatingSessionId,
      mode: effectiveMode,
      bridgeOutUrl: typeof bridge_out_url === "string" ? bridge_out_url : undefined,
      metaPixelOverride,
      googleAds,
    });
    void emitLanderLifecycle("created", { pageId: (result as any)?.id || "unknown", userId, channel: landerChannelFromRequest(req), mode: "cold_start", outcome: (result as any)?.status === "failed" ? "failed" : "ok" });
    res.status(201).json(leadListWarning ? { ...result, warnings: [leadListWarning] } : result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error generating landing page:", {
      userId: (req as unknown as AuthenticatedRequest).user?.userId,
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: error?.message,
      stack: error?.stack,
    });
    void emitLanderLifecycle("created", { pageId: "unknown", userId: (req as unknown as AuthenticatedRequest).user?.userId, channel: landerChannelFromRequest(req), mode: "cold_start", outcome: "failed" });
    res.status(500).json({ error: "Failed to generate landing page", details: error?.message });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/deploy
 * Deploy a generated landing page to Vercel
 */
router.post("/generated/:id/deploy", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const result = await deployLandingPage(auth.page.id, auth.page.userId);
    void emitLanderLifecycle("deploy_retried", { pageId: auth.page.id, userId, channel: landerChannelFromRequest(req) });
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error deploying:", error);
    // ENG-2083: a page that is already deployed (or otherwise in a non-deployable state) is
    // a 409, not a 500 — the request is invalid, the server is fine, and retrying it can
    // never succeed. Checked by `code` rather than `instanceof` so it survives re-wrapping.
    const status =
      error?.code === "LP_NOT_DEPLOYABLE"
        ? 409
        : error.message?.includes("not found")
        ? 404
        : 500;
    res.status(status).json({ error: error.message || "Failed to deploy" });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/iterate
 * Refine a landing page with follow-up instructions
 */
router.post("/generated/:id/iterate", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required and must be a string" });
    }

    if (message.length > MAX_INPUT_LENGTH) {
      return res.status(400).json({ error: `message must not exceed ${MAX_INPUT_LENGTH} characters` });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    // ENG-694 AC5: pass the acting member alongside the owner. `auth.page.userId`
    // stays the billing subject; `userId` is whoever actually asked for the edit,
    // and authorizeLandingPageAccess has already proven they may.
    const result = await iterateLandingPage(auth.page.id, auth.page.userId, message, userId);
    void emitLanderLifecycle("iterated", { pageId: auth.page.id, userId, channel: landerChannelFromRequest(req), mode: "incremental" });
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error iterating:", error);
    const status = error.message?.includes("not found") ? 404 : 500;
    res.status(status).json({ error: error.message || "Failed to iterate" });
  }
});

/**
 * GET /api/landing-pages/v0/generated
 * List all generated landing pages for the current user, plus org members' pages when enabled.
 */
router.get("/generated", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await userDb.getUserById(userId);
    const orgId = user?.orgId;
    const org = orgId ? await orgDb.getOrgById(orgId) : null;
    const lpEnabled = isFeatureEffectivelyEnabled(
      { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined },
      org,
      "landingPages",
    );

    const [ownPages, orgPages] = await Promise.all([
      getLandingPagesByOwner(userId),
      (orgId && lpEnabled) ? getLandingPagesByOrg(orgId, userId) : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    const pages = [...ownPages, ...orgPages].filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // Resolve each page's public URL from the domain ACTUALLY attached to its
    // Vercel project (AW-CustomDomains is the source of truth). This does two
    // things:
    //   1. Fills in customDomainUrl for historical records that never persisted
    //      one.
    //   2. Corrects a stored managed subdomain (*.agentwebforms.com) that has
    //      gone stale — e.g. the page kept an old subdomain that is no longer
    //      attached to the project, which serves a Vercel DEPLOYMENT_NOT_FOUND
    //      404. The attached subdomain replaces it.
    // Lookups are scoped per PAGE OWNER, not the caller: an org member viewing
    // a shared page owns no domains, so a caller-scoped lookup would skip
    // enrichment entirely and surface the stale URL.
    try {
      const ownerIds = [...new Set(pages.map((p) => p.userId).filter(Boolean))];
      const domainsByOwner = await Promise.all(
        ownerIds.map(async (ownerId) => [ownerId, await listDomains(ownerId)] as const),
      );

      // Map: `${ownerId}::${vercelProjectId}` → best attached domain record.
      // Prefer a verified custom domain over a managed subdomain; break ties by
      // most-recently-updated.
      const bestByOwnerProject = new Map<string, CustomDomainRecord>();
      // Three tiers, not two. A verified custom domain is what the customer wants shown; a
      // managed subdomain is the working fallback; a custom domain that is not verified yet
      // cannot serve at all and must never be picked.
      //
      // Ranking on type alone let a `pending_verification` custom domain win. Since the
      // reachability sweep deliberately does not probe unverified domains, that winning row
      // could never carry a verdict — so a managed subdomain confirmed UNREACHABLE went
      // unreported for as long as a custom domain sat half-configured on the same project, and
      // the page's URL was rewritten to a host with no DNS. Demoting it to the subdomain's own
      // tier is not enough either: the tie then breaks on `updatedAt`, and the freshly-added
      // custom domain is always the newer row.
      //
      // NOT the same ordering as `getProjectDomain`, despite the similar shape: that helper
      // returns active-custom → pending-custom → null and never considers subdomains at all,
      // so it still answers with the pending custom exactly where this ranking prefers the
      // working subdomain. Deliberate — it answers "which custom domain is attached", this
      // answers "what should we show the customer".
      const rank = (d: CustomDomainRecord) => {
        if (d.type === "custom") return d.status === "active" ? 2 : 0;
        return 1; // managed subdomain — addSubdomain writes these active unconditionally
      };
      for (const [ownerId, domains] of domainsByOwner) {
        for (const d of domains) {
          if (!d.vercelProjectId) continue;
          /*
           * `rank` is a comparator, not a filter, and the `!existing` seed below is
           * unconditional — so rank 0 means "loses a comparison", never "is rejected". Skip
           * these outright: a project whose only attached row is an unverified custom domain
           * has nothing to lose to, and would otherwise be adopted as the page's reported host
           * despite having no DNS. That is the failure this ranking exists to prevent.
           */
          if (rank(d) === 0) continue;
          const key = `${ownerId}::${d.vercelProjectId}`;
          const existing = bestByOwnerProject.get(key);
          if (
            !existing ||
            rank(d) > rank(existing) ||
            (rank(d) === rank(existing) && d.updatedAt > existing.updatedAt)
          ) {
            bestByOwnerProject.set(key, d);
          }
        }
      }

      for (const page of pages) {
        if (!page.vercelProjectId || !page.userId) continue;
        const best = bestByOwnerProject.get(`${page.userId}::${page.vercelProjectId}`);
        if (!best) continue;

        // ENG-1839: surface whether the domain actually serves. The value is written by the
        // hourly reachability sweep; this only reads what is already loaded here for URL
        // enrichment, so it costs no extra calls and triggers no verification of its own.
        // (An earlier version fired verification from this read — see the sweep's header for
        // why that was wrong.)
        // Reachability, written by the hourly sweep to its own attribute. Deliberately NOT
        // `best.status` — that is the Vercel verification state, and conflating the two made a
        // transient 5xx render a customer's custom domain as "not configured".
        page.domainHost = best.domain;
        if (best.reachabilityStatus === "unreachable") {
          page.domainStatus = "error";
          if (best.reachabilityError) page.domainErrorMessage = best.reachabilityError;
        } else if (best.reachabilityStatus === "reachable") {
          page.domainStatus = "active";
        }
        // Sub-pages have a slug and live at /{slug} under the attached domain.
        const targetUrl = page.slug
          ? `https://${best.domain}/${page.slug}`
          : `https://${best.domain}`;

        if (!page.customDomainUrl) {
          page.customDomainUrl = targetUrl;
          continue;
        }
        // Only correct stored MANAGED subdomains (*.agentwebforms.com): those
        // are the ones that can silently detach. A real custom domain stored on
        // the page is user-managed and left untouched.
        let storedHost: string | null = null;
        try {
          storedHost = new URL(page.customDomainUrl).host;
        } catch {
          /* malformed stored URL — fall through to leave it as-is */
        }
        if (
          storedHost &&
          storedHost.endsWith(`.${SUBDOMAIN_BASE}`) &&
          storedHost !== best.domain
        ) {
          page.customDomainUrl = targetUrl;
        }
      }
    } catch {
      // Non-fatal — return pages without enrichment if domain lookup fails
    }

    // Auto-heal: for pages stuck in "failed" or "deploying" that have a Vercel project,
    // check Vercel in parallel and correct their status before responding.
    const stalePages = pages.filter(
      (p) => (p.status === "failed" || p.status === "deploying") && p.vercelProjectId
    );
    if (stalePages.length > 0) {
      try {
        const healResults = await Promise.allSettled(
          stalePages.map((p) => getDeploymentStatus(p.id, userId))
        );
        healResults.forEach((result, idx) => {
          if (result.status === "fulfilled" && result.value.status === "deployed") {
            stalePages[idx].status = "deployed";
          }
        });
      } catch {
        // Non-fatal — return pages with existing status if heal fails
      }
    }

    // Annotate each page with whether THIS caller can edit it. The list mixes
    // the caller's own pages with org-shared pages they may only be able to
    // view; without this flag the agent can't tell which it may edit and wastes
    // attempts (and mislabels the resulting 403 as a platform bug). Every page
    // here is either the caller's own or owned by an org member (same org via
    // fanout), so the already-loaded `org` is the right context — no extra DB
    // calls. Owner fast-paths to true; otherwise canEditItem gates on
    // editor/owner role.
    const annotated = pages.map((p) => ({
      ...(isExternalLandingPageRecord(p)
        ? { ...p, customDomainUrl: p.customDomainUrl || p.canonicalUrl || p.deployedUrl }
        : p),
      isExternalImport: isExternalLandingPageRecord(p),
      editable: canEditItem(
        { userId: p.userId },
        { userId, orgId, orgRole: user?.orgRole as "owner" | "member" | undefined },
        org,
        orgId,
        "landingPages",
      ),
    }));

    res.json({ pages: annotated });
  } catch (error) {
    console.error("[LP GENERATION] Error listing pages:", error);
    res.status(500).json({ error: "Failed to list landing pages" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id
 * Get a specific generated landing page
 */
router.get("/generated/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    // Surface whether the caller may edit (vs only view) this page so the agent
    // doesn't attempt edits it isn't authorized for. Owner short-circuits to
    // true; org viewers without editor rights get false.
    const editable = await canUserEditLandingPage(auth.page, userId);
    res.json({ ...auth.page, editable });
  } catch (error) {
    console.error("[LP GENERATION] Error getting page:", error);
    res.status(500).json({ error: "Failed to get landing page" });
  }
});

/**
 * DELETE /api/landing-pages/v0/generated/:id
 * Delete a generated landing page record.
 * Caller must be the page owner OR an org owner (orgRole === "owner").
 * Editors in shareSettings.landingPages.editors may NOT delete.
 */
router.delete("/generated/:id", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const page = await getLandingPageById(req.params.id);
    if (!page) {
      return res.status(404).json({ error: "Landing page not found" });
    }

    // Owner can always delete their own page; org owner (orgRole === "owner") can also delete
    if (page.userId !== userId) {
      const [user, pageOwner] = await Promise.all([
        userDb.getUserById(userId),
        userDb.getUserById(page.userId),
      ]);
      const ownerOrgId = pageOwner?.orgId;
      const callerOrgId = user?.orgId;
      // Must be in same org AND be an org owner to delete another member's page
      if (!callerOrgId || !ownerOrgId || callerOrgId !== ownerOrgId || user?.orgRole !== "owner") {
        return res.status(403).json({ error: "Not authorized to delete this landing page" });
      }
    }

    const { githubCleanupWarning } = await deleteLandingPageByRecord(page);
    res.json({ success: true, ...(githubCleanupWarning ? { warning: githubCleanupWarning } : {}) });
  } catch (error: any) {
    console.error("[LP GENERATION] Error deleting page:", error);
    const status = error.message?.includes("not found") ? 404
      : error.message?.includes("Cannot delete") ? 400
      : 500;
    res.status(status).json({ error: error.message || "Failed to delete" });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/duplicate
 * Duplicate a landing page record for independent editing
 */
// ENG-705: duplicate re-runs a FULL v0 generation, so it is exactly as
// expensive as /generate and is gated identically — the shared `rateLimiter`
// (same quota as generate/deploy/iterate, so it cannot be used to bypass them)
// and "edit" access, matching /iterate rather than the old "view".
router.post("/generated/:id/duplicate", rateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    // ENG-1238: external imports have no build behind them — duplicating would
    // re-run a full v0 generation from the imported stub prompt.
    if (isExternalLandingPageRecord(auth.page)) {
      return res.status(409).json({ error: "Externally-imported pages cannot be duplicated" });
    }
    const original = auth.page;

    const { name } = req.body;
    const newName = name || `${original.name} (copy)`;

    // Re-generate using the original prompt + full brand context (shared
    // ENG-326 projection — org-aware, persisted logo attachments-first).
    const user = await userDb.getUserById(userId);
    const org = user?.orgId ? await orgDb.getOrgById(user.orgId) : null;
    const brandContext = buildBrandContextFromUser(
      user,
      org ? await resolveOrgProfileField(user, org, "brandGuidelines") : undefined,
      org,
    );

    // ENG-326 AC-3: duplicating re-generates the page — same gate as
    // /generate. Without a persisted logo v0 would invent a wordmark.
    if (!brandContext.logoUrl) {
      return res.status(422).json({
        error: MISSING_BRAND_LOGO_ERROR,
        message:
          "No brand logo is saved in Brand Guidelines. Upload your logo in brand config " +
          "(Brand Guidelines), then duplicate again — landing pages are never generated " +
          "with an invented or approximate logo.",
      });
    }

    // ENG-449 capture-or-fail: carry over the original page's own list if it had one;
    // otherwise resolve/create the same default list /generate uses. A duplicated page
    // used to start completely unbound — this closes that gap without needing a new
    // request field, consistent with the "no page is ever generated unbound" intent.
    // ENG-2323: a page bound to a session list before it was refused (or via the API) must not hand
    // that binding on to the copy. Checked before any generation spend.
    if (original.leadListId && isSessionList(await crmDb.getLeadListById(original.leadListId))) {
      return res.status(400).json({ error: SESSION_LIST_LEAD_CAPTURE_ERROR });
    }
    const leadListId = original.leadListId || (await resolveOrCreateDefaultLeadList(userId, user?.orgId)).id;

    // ENG-967: same as /generate — a bound list that isn't publicly submittable makes the
    // copy's form drop every lead. The carried-over list is not necessarily public (the
    // original may predate ENG-449), and a freshly provisioned default list never is.
    //
    // Deliberately NOT repeating the list-level canEditItem check PATCH /lead-list runs: this
    // list is not caller-supplied. It is either the original page's own list — and ENG-449
    // already binds it to the copy on the strength of the "edit" authorization above — or one
    // this caller just had provisioned. Enabling submissions on a list we are binding anyway
    // is strictly smaller than the bind itself, so a check here would reject nothing the bind
    // permits.
    const leadListWarning = await ensureLeadListAcceptsPublicSubmissions(leadListId);

    const result = await generateLandingPage(userId, original.prompt, newName, brandContext, leadListId);
    res.status(201).json(leadListWarning ? { ...result, warnings: [leadListWarning] } : result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error duplicating:", error);
    res.status(500).json({ error: "Failed to duplicate landing page" });
  }
});

/**
 * PUT /api/landing-pages/v0/generated/:id/github-edit
 * Edit a file in the landing page's GitHub repository.
 * Uses Contents API for files <=1MB, Blob API for larger files.
 * Retries once on SHA mismatch (409 conflict).
 */
router.put("/generated/:id/github-edit", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;

    if (!page.githubRepoUrl) {
      return res.status(400).json({ error: "Landing page has no GitHub repository" });
    }

    // Parse owner/repo from GitHub URL
    const match = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      return res.status(400).json({ error: "Invalid GitHub repo URL" });
    }

    const [, owner, repo] = match;
    const { file_path, content, commit_message, branch: rawBranch } = req.body;
    const branch: string = rawBranch || "main";

    // content === "" is a legitimate empty file, not a missing one (Greptile) —
    // only an actually-absent value should be rejected. Mirrors update-files'
    // already-correct check for the same reason.
    if (!file_path || content === undefined || content === null) {
      return res.status(400).json({ error: "file_path and content are required" });
    }

    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name. Must be 'main' or 'draft/agentweb-preview'." });
    }

    // Prevent path traversal attacks
    if (file_path.includes('..') || file_path.startsWith('.github/') || file_path.startsWith('.github\\')) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    const GITHUB_TIMEOUT_MS = 30_000;
    const repoBase = `https://api.github.com/repos/${owner}/${repoName}`;

    // Ensure the target branch exists (creates from main if needed)
    const branchJustCreated = await ensureBranchExists(repoBase, branch, ghHeaders, GITHUB_TIMEOUT_MS);

    const base64Content = Buffer.from(content, "utf-8").toString("base64");
    const contentSizeBytes = Buffer.byteLength(content, "utf-8");
    const CONTENTS_API_LIMIT = 1_000_000; // 1MB limit for Contents API

    // Helper: get current file SHA (needed for updates via Contents API)
    const getFileSha = async (): Promise<string | undefined> => {
      try {
        const refParam = branch !== "main" ? `?ref=${branch}` : "";
        const fileRes = await axios.get<any>(
          `${repoBase}/contents/${file_path}${refParam}`,
          { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
        );
        return fileRes.data.sha;
      } catch (err: any) {
        if (err.response?.status === 404) {
          // If we just created the branch, the file should exist (copied from main)
          // but GitHub's eventual consistency may cause a brief 404. Retry once.
          if (branchJustCreated) {
            console.log(`[LP GENERATION] File ${file_path} not found on new branch ${branch}, retrying after 1s...`);
            await new Promise(r => setTimeout(r, 1000));
            try {
              const retryRes = await axios.get<any>(
                `${repoBase}/contents/${file_path}?ref=${branch}`,
                { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
              );
              return retryRes.data.sha;
            } catch (retryErr: any) {
              if (retryErr.response?.status === 404) return undefined; // truly new file
              throw retryErr;
            }
          }
          return undefined; // new file
        }
        throw err;
      }
    };

    // Helper: commit via Contents API (files <=1MB)
    const commitViaContentsApi = async (sha: string | undefined) => {
      const putBody: any = {
        message: commit_message || `Update ${file_path} via Emma`,
        content: base64Content,
      };
      if (sha) putBody.sha = sha;
      if (branch !== "main") putBody.branch = branch;

      return axios.put<any>(
        `${repoBase}/contents/${file_path}`,
        putBody,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
    };

    // Helper: commit via Blob + Tree + Commit API (files >1MB)
    const commitViaBlobApi = async () => {
      // 1. Create a blob
      const blobRes = await axios.post<any>(
        `${repoBase}/git/blobs`,
        { content: base64Content, encoding: "base64" },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      const blobSha = blobRes.data.sha;

      // 2. Get the latest commit SHA on the target branch
      const refRes = await axios.get<any>(
        `${repoBase}/git/ref/heads/${branch}`,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      const latestCommitSha = refRes.data.object.sha;

      // 3. Create a tree with the new blob
      const treeRes = await axios.post<any>(
        `${repoBase}/git/trees`,
        {
          base_tree: latestCommitSha,
          tree: [{ path: file_path, mode: "100644", type: "blob", sha: blobSha }],
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );

      // 4. Create a commit
      const newCommitRes = await axios.post<any>(
        `${repoBase}/git/commits`,
        {
          message: commit_message || `Update ${file_path} via Emma`,
          tree: treeRes.data.sha,
          parents: [latestCommitSha],
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );

      // 5. Update the ref
      await axios.patch<any>(
        `${repoBase}/git/refs/heads/${branch}`,
        { sha: newCommitRes.data.sha },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );

      return newCommitRes;
    };

    let commitRes: any;

    if (contentSizeBytes > CONTENTS_API_LIMIT) {
      // Large file: use Blob API (no size limit)
      console.log(`[LP GENERATION] File ${file_path} is ${contentSizeBytes} bytes, using Blob API`);
      commitRes = await commitViaBlobApi();
    } else {
      // Normal file: use Contents API with SHA mismatch retry
      let fileSha = await getFileSha();
      try {
        commitRes = await commitViaContentsApi(fileSha);
      } catch (err: any) {
        if (err.response?.status === 409) {
          // SHA mismatch — refetch SHA and retry once
          console.log(`[LP GENERATION] SHA mismatch for ${file_path}, retrying with fresh SHA`);
          fileSha = await getFileSha();
          commitRes = await commitViaContentsApi(fileSha);
        } else {
          throw err;
        }
      }
    }

    const isStaging = branch !== "main";
    const liveUrl = await resolveLandingPageLiveUrl(page);
    void emitLanderLifecycle("edited", { pageId: page.id, userId: (req as unknown as AuthenticatedRequest).user?.userId, channel: landerChannelFromRequest(req), mode: "incremental" });
    res.json({
      success: true,
      commit_url: commitRes.data.commit?.html_url || commitRes.data.html_url,
      file_path,
      page_id: page.id,
      live_url: liveUrl,
      deployed_url: page.deployedUrl,
      branch,
      is_staging: isStaging,
      message: isStaging
        ? `File "${file_path}" updated on branch ${branch}. A Vercel preview deployment will be created. Use get_preview_url to check the preview, then publish_landing_page_changes when ready to go live.`
        : `File "${file_path}" updated. Changes will auto-deploy to ${liveUrl} within ~30 seconds.`,
    });
  } catch (error: any) {
    const ghStatus = error.response?.status;
    const ghMessage = error.response?.data?.message || error.message;
    console.error(`[LP GENERATION] Error with github edit (HTTP ${ghStatus}):`, ghMessage);

    // Return actionable error details so Emma can adjust
    if (ghStatus === 401 || ghStatus === 403) {
      res.status(ghStatus).json({ error: `GitHub auth error: ${ghMessage}` });
    } else if (ghStatus === 409) {
      res.status(409).json({ error: `SHA conflict: the file was modified externally. ${ghMessage}` });
    } else if (ghStatus === 422) {
      res.status(422).json({ error: `GitHub rejected the request: ${ghMessage}` });
    } else if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      res.status(504).json({ error: `GitHub API timed out after 30s. The file may be too large or GitHub is slow.` });
    } else {
      res.status(500).json({ error: `GitHub API error (${ghStatus || 'unknown'}): ${ghMessage}` });
    }
  }
});

const MAX_UPDATE_FILES_PER_COMMIT = 20;

/**
 * PUT /api/landing-pages/v0/generated/:id/update-files
 * ENG-497: commit several files to an existing lander's repo in ONE atomic
 * commit — the multi-file cousin of github-edit (which commits exactly one
 * file per call). Reuses commitFilesToRepoMain, the same retry/rebase-safe
 * commit path generation itself trusts, authored via the org's GitHub App
 * token (not a personal git identity) — this is why it doesn't hit Vercel's
 * "commit must be authored by agentwebdeployer" deploy-guard block that
 * forced a manual re-authored git push during the ENG-443 incident.
 *
 * Supports the reusable staging branch (draft/agentweb-preview) the same
 * way github-edit does — creating it from main first via ensureBranchExists
 * if it doesn't exist yet — since commitFilesToRepoMain now accepts a
 * branch parameter (defaults to "main").
 */
router.put("/generated/:id/update-files", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;

    if (!page.githubRepoUrl) {
      return res.status(400).json({ error: "Landing page has no GitHub repository" });
    }

    const match = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
      return res.status(400).json({ error: "Invalid GitHub repo URL" });
    }
    const [, owner, repo] = match;
    const repoName = repo.replace(".git", "");
    const repoFullName = `${owner}/${repoName}`;

    const { files, commit_message, branch: rawBranch, expected_base_sha } = req.body;
    const branch: string = rawBranch || "main";
    if (expected_base_sha !== undefined && (typeof expected_base_sha !== "string" || !/^[0-9a-f]{40}$/i.test(expected_base_sha))) {
      return res.status(400).json({ error: "expected_base_sha must be a 40-character commit SHA" });
    }
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name. Must be 'main' or 'draft/agentweb-preview'." });
    }
    if (!commit_message || typeof commit_message !== "string") {
      return res.status(400).json({ error: "commit_message is required" });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "files must be a non-empty array" });
    }
    if (files.length > MAX_UPDATE_FILES_PER_COMMIT) {
      return res.status(400).json({ error: `files must not exceed ${MAX_UPDATE_FILES_PER_COMMIT} entries per commit` });
    }

    const filesToCommit: Array<{ path: string; content?: Buffer; deleted?: boolean }> = [];
    for (const f of files) {
      const filePath = f?.file_path;
      if (!filePath || typeof filePath !== "string") {
        return res.status(400).json({ error: "Each file requires a file_path" });
      }
      if (filePath.includes("..") || filePath.startsWith(".github/") || filePath.startsWith(".github\\")) {
        return res.status(400).json({ error: `Invalid file path: ${filePath}` });
      }
      if (!f.deleted && (f.content === undefined || f.content === null)) {
        return res.status(400).json({ error: `File ${filePath} requires content (or deleted: true)` });
      }
      filesToCommit.push({
        path: filePath,
        ...(f.deleted ? { deleted: true } : { content: Buffer.from(String(f.content), "utf-8") }),
      });
    }

    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };

    if (branch !== "main") {
      await ensureBranchExists(`https://api.github.com/repos/${owner}/${repoName}`, branch, ghHeaders, 30_000);
    }

    const { pushedCommitSha } = await commitFilesToRepoMain(
      repoFullName,
      ghHeaders,
      filesToCommit as any,
      commit_message,
      4,
      branch,
      expected_base_sha
    );

    const isStaging = branch !== "main";
    const liveUrl = await resolveLandingPageLiveUrl(page);
    void emitLanderLifecycle("edited", { pageId: page.id, userId, channel: landerChannelFromRequest(req), mode: "incremental" });
    res.json({
      success: true,
      commit_url: `https://github.com/${repoFullName}/commit/${pushedCommitSha}`,
      files: filesToCommit.map((f) => f.path),
      page_id: page.id,
      live_url: liveUrl,
      deployed_url: page.deployedUrl,
      branch,
      is_staging: isStaging,
      message: isStaging
        ? `${filesToCommit.length} file(s) updated on branch ${branch}. A Vercel preview deployment will be created.`
        : `${filesToCommit.length} file(s) updated in one commit. Changes will auto-deploy to ${liveUrl} within ~30 seconds.`,
    });
  } catch (error: any) {
    const ghStatus = error.response?.status;
    const ghMessage = error.response?.data?.message || error.message;
    // Matched by name (not instanceof) so route tests that mock v0Service keep working.
    if (error?.name === "BaseShaConflictError") {
      return res.status(409).json({
        error: `Base SHA conflict: ${error.message} Nothing was written.`,
        expected_base_sha: error.expectedSha,
        actual_base_sha: error.actualSha,
      });
    }
    console.error(`[LP GENERATION] Error with update-files (HTTP ${ghStatus}):`, ghMessage);
    if (ghStatus === 401 || ghStatus === 403) {
      res.status(ghStatus).json({ error: `GitHub auth error: ${ghMessage}` });
    } else if (ghStatus === 422) {
      res.status(422).json({ error: `GitHub rejected the request: ${ghMessage}` });
    } else if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      res.status(504).json({ error: `GitHub API timed out. Files may be too large or GitHub is slow.` });
    } else {
      res.status(500).json({ error: `GitHub API error (${ghStatus || "unknown"}): ${ghMessage}` });
    }
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/verify-live-mapping
 * ENG-496: verify this page's stored githubRepoUrl/vercelProjectId against
 * what Vercel is ACTUALLY serving at its live URL. Surfaces a sibling record
 * whose own githubRepoUrl matches reality when this one has drifted — the
 * same manual GitHub-search step Harsha had to do by hand during ENG-443.
 */
router.get("/generated/:id/verify-live-mapping", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const result = await verifyLanderLiveMapping(auth.page);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error verifying live mapping:", error);
    res.status(500).json({ error: error.message || "Failed to verify live mapping" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/deployment-status
 * Check the Vercel build/deployment status for a landing page.
 * Returns build status, errors if any, and deployed URL.
 */
router.get("/generated/:id/deployment-status", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const result = await getDeploymentStatus(auth.page.id, auth.page.userId);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error checking deployment status:", error);
    res.status(500).json({ error: error.message || "Failed to check deployment status" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/files
 * List files in the landing page's GitHub repo (recursive).
 */
router.get("/generated/:id/files", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const match = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = match;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const branch = (req.query.branch as string) || "main";
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    let effectiveBranch = branch;
    let treeRes;
    try {
      treeRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
      );
    } catch (branchErr: any) {
      // If draft branch doesn't exist yet, fall back to main
      if (branch !== "main" && branchErr.response?.status === 404) {
        effectiveBranch = "main";
        treeRes = await axios.get<any>(
          `https://api.github.com/repos/${owner}/${repoName}/git/trees/main?recursive=1`,
          { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
        );
      } else {
        throw branchErr;
      }
    }

    const files = treeRes.data.tree
      .filter((item: any) => item.type === "blob")
      .map((item: any) => ({ path: item.path, size: item.size }));

    res.json({ files, repo: `${owner}/${repoName}`, branch: effectiveBranch });
  } catch (error: any) {
    console.error("[LP GENERATION] Error listing files:", error);
    res.status(500).json({ error: "Failed to list files" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/files/:path(*)
 * Read a file from the landing page's GitHub repo.
 */
router.get("/generated/:id/file-content", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path query parameter is required" });

    const branch = (req.query.branch as string) || "main";
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    // Prevent path traversal attacks
    if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const refParam = branch !== "main" ? `?ref=${branch}` : "";
    let fileRes;
    try {
      fileRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}${refParam}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
      );
    } catch (refErr: any) {
      if (refErr.response?.status === 404) {
        // Draft branch doesn't exist yet — fall back to main
        if (branch !== "main") {
          try {
            fileRes = await axios.get<any>(
              `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
              { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" } }
            );
          } catch (mainErr: any) {
            // File also doesn't exist on main — new file
            if (mainErr.response?.status === 404) {
              return res.status(404).json({ error: "File not found", newFile: true });
            }
            throw mainErr;
          }
        } else {
          // File doesn't exist on main either — new file
          return res.status(404).json({ error: "File not found", newFile: true });
        }
      } else {
        throw refErr;
      }
    }

    const content = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
    res.json({ path: filePath, content, sha: fileRes.data.sha });
  } catch (error: any) {
    console.error("[LP GENERATION] Error reading file:", error);
    res.status(500).json({ error: "Failed to read file" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/commits
 * List recent commits for the landing page's GitHub repo.
 * Optional query param: ?path=app/page.tsx to filter by file.
 */
router.get("/generated/:id/commits", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const branch = (req.query.branch as string) || "main";
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    const params: Record<string, string> = { per_page: "20", sha: branch };
    const filePath = req.query.path as string | undefined;
    if (filePath) {
      if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
        return res.status(400).json({ error: "Invalid file path" });
      }
      params.path = filePath;
    }

    let commitsRes;
    try {
      commitsRes = await axios.get<any>(
        `https://api.github.com/repos/${owner}/${repoName}/commits`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
          params,
          timeout: 30_000,
        }
      );
    } catch (commitErr: any) {
      // If draft branch doesn't exist yet, fall back to main
      if (branch !== "main" && commitErr.response?.status === 404) {
        params.sha = "main";
        commitsRes = await axios.get<any>(
          `https://api.github.com/repos/${owner}/${repoName}/commits`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
            params,
            timeout: 30_000,
          }
        );
      } else {
        throw commitErr;
      }
    }

    const commits = commitsRes.data.map((c: any) => ({
      sha: c.sha,
      message: c.commit.message,
      date: c.commit.committer?.date || c.commit.author?.date,
      author: c.commit.author?.name || "unknown",
    }));

    res.json({ commits });
  } catch (error: any) {
    console.error("[LP GENERATION] Error listing commits:", error);
    res.status(500).json({ error: "Failed to list commits" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/file-at-commit
 * Read a file at a specific commit from the landing page's GitHub repo.
 * Query params: ?path=app/page.tsx&ref=abc123
 */
router.get("/generated/:id/file-at-commit", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const filePath = req.query.path as string;
    const ref = req.query.ref as string;
    if (!filePath) return res.status(400).json({ error: "path query parameter is required" });
    if (!ref) return res.status(400).json({ error: "ref query parameter is required" });

    if (filePath.includes('..') || filePath.startsWith('.github/') || filePath.startsWith('.github\\')) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    // Validate ref is a hex SHA prefix (7-40 chars) to prevent injection
    if (!/^[0-9a-f]{7,40}$/i.test(ref)) {
      return res.status(400).json({ error: "Invalid commit ref — must be a SHA hash" });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();

    const fileRes = await axios.get<any>(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}?ref=${ref}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" }, timeout: 30_000 }
    );

    const content = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
    res.json({ path: filePath, content, sha: fileRes.data.sha, commit_ref: ref });
  } catch (error: any) {
    console.error("[LP GENERATION] Error reading file at commit:", error);
    const ghStatus = error.response?.status;
    if (ghStatus === 404) {
      return res.status(404).json({ error: "File not found at the specified commit" });
    }
    res.status(500).json({ error: "Failed to read file at commit" });
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/publish
 * Merge a draft branch into main and delete the draft branch.
 * This makes the staged changes live on the production Vercel deployment.
 */
router.post("/generated/:id/publish", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const { branch } = req.body;
    if (!branch || branch === "main") {
      return res.status(400).json({ error: "A draft branch name is required (not 'main')" });
    }
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    const GITHUB_TIMEOUT_MS = 30_000;
    const repoBase = `https://api.github.com/repos/${owner}/${repoName}`;

    let mergeCommitSha: string;

    // Capture the current main SHA before merging. This is the exact byte-perfect
    // rollback target — revert-publish force-resets main back to it. Non-fatal if
    // it can't be read (revert simply won't be offered for this publish).
    let preMergeSha: string | undefined;
    try {
      const mainRefRes = await axios.get<any>(
        `${repoBase}/git/ref/heads/main`,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      preMergeSha = mainRefRes.data.object.sha;
    } catch (refErr: any) {
      console.warn(`[LP GENERATION] Could not read pre-merge main SHA: ${refErr.message}`);
    }

    // Try a standard merge first; on conflict (409) fall back to force-advancing
    // main to the draft branch tip. This is safe because landing page repos are
    // exclusively managed by our system — there is no external contributor whose
    // work we could clobber. A 409 means the branches diverged (e.g. a previous
    // "resolve conflict with ours" commit was applied to main directly) and the
    // draft still contains the canonical desired state.
    // ENG-827 (Greptile): last moment before this page goes live.
    //
    // `publish_landing_page_changes` is checked at dispatch, but the irreversible act
    // is the merge below — and it happens here, on the far side of a self-call, after
    // a Secrets Manager fetch and a GitHub read that is allowed 30s. An owner who
    // revokes in that window would otherwise still get a public deployment. Rebuild
    // the run's re-check from the session the tool forwarded and run it now, after all
    // the reads and immediately before the write, so no window is left after this
    // point. No session header means an interactive publish, which is not gated.
    // There are TWO writes that can advance main — the standard merge and the 409
    // fallback's force-update — and the fallback reaches its one through a failed
    // merge and another 30s branch read, so a single check up front would let that
    // path publish on a decision taken a minute earlier. Re-read immediately before
    // each of them instead; a third write site added later has one obvious call to
    // make rather than a block to remember to copy.
    const refuseIfConsentWithdrawn = async (): Promise<boolean> => {
      const withdrawn = await publishWithdrawnMidFlight(
        publishRevalidationForForwardedRun(req, "publish_landing_page_changes")
      );
      if (!withdrawn) return false;
      console.warn(`[LP GENERATION] Publish abandoned for ${page.id}: ${withdrawn.error}`);
      res.status(403).json({ error: withdrawn.error });
      return true;
    };

    // A generated branch has no CI of its own: the landing-page repository runs
    // Tests for pull requests. Open (or reuse) that repository-supported review
    // path, then inspect the exact draft SHA before any write can advance main.
    // The route deliberately returns a retryable, non-500 result while GitHub is
    // still running the check; it never treats a branch-level result as proof for
    // a different commit.
    if (await refuseIfConsentWithdrawn()) return;

    const draftRefRes = await axios.get<any>(
      `${repoBase}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
    );
    const draftSha: string = draftRefRes.data.object.sha;
    const findOpenDraftPr = () => axios.get<any[]>(`${repoBase}/pulls`, {
      headers: ghHeaders,
      timeout: GITHUB_TIMEOUT_MS,
      params: { state: "open", head: `${owner}:${branch}`, base: "main" },
    });
    const existingPrRes = await findOpenDraftPr();

    if (existingPrRes.data.length === 0) {
      try {
        await axios.post(
          `${repoBase}/pulls`,
          {
            title: `Publish landing page changes from ${branch}`,
            head: branch,
            base: "main",
            body: "Automated publish check for the generated landing-page draft.",
          },
          { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
        );
      } catch (createPrErr: any) {
        // Another publish request can create the same PR after our lookup. GitHub
        // returns 422 for that benign race; prove the PR now exists before reuse.
        const createPrMessages = [
          createPrErr.response?.data?.message,
          ...(Array.isArray(createPrErr.response?.data?.errors)
            ? createPrErr.response.data.errors.map((error: { message?: string }) => error.message)
            : []),
        ].filter((message): message is string => typeof message === "string");
        const isDuplicatePr = createPrMessages.some((message) => /pull request already exists/i.test(message));
        if (createPrErr.response?.status !== 422 || !isDuplicatePr) throw createPrErr;
        const racedPrRes = await findOpenDraftPr();
        if (racedPrRes.data.length === 0) throw createPrErr;
      }
    }

    // Fetch the checks for this draft first — unchanged position, so a repo that DOES report a
    // Tests check behaves exactly as before and makes no extra API call.
    const checksRes = await axios.get<any>(
      `${repoBase}/commits/${draftSha}/check-runs`,
      { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
    );
    const checkRuns = checksRes.data?.check_runs || [];
    const testsCheck = checkRuns.find((check: { name?: string }) => check.name === "Tests");

    // Checks posted by GitHub Apps we KNOW are not test runners — Vercel's own integration
    // auto-deploys and posts a check ("Vercel Preview Comments") for ANY PR on a connected
    // project, unconditionally, and this route always opens a PR as its first step. Filtered by
    // `app.slug` (a stable identifier) rather than the check's display name, which Vercel could
    // change without notice.
    const KNOWN_NON_TEST_CHECK_APP_SLUGS = new Set(["vercel"]);
    const nonBenignCheckRuns = checkRuns.filter(
      (check: { app?: { slug?: string } }) =>
        !KNOWN_NON_TEST_CHECK_APP_SLUGS.has(check.app?.slug?.toLowerCase() ?? "")
    );

    // Is this a repo that can never produce a Tests check at all?
    //
    // The gate is correct for a repo that runs tests and UNSATISFIABLE for one that does not.
    // Generated landing-page repos contain no `.github/workflows`, so no check named "Tests"
    // can appear and publish returned 409 required_tests_pending forever — its own message
    // said "retry after GitHub starts it", which GitHub never would. That blocked a customer's
    // rebuilt page from being published at all.
    //
    // ENG-1856: an earlier version of this fix required `checkRuns.length === 0` before
    // trusting the workflow count — a repo whose checks come from a GitHub App (CircleCI,
    // Buildkite, a bespoke checker) reports `actions/workflows` total_count 0 while real checks
    // exist, so demanding zero check runs kept the gate honest for that case. In practice
    // `checkRuns.length` was never actually 0 on a real publish attempt (Vercel's own bot check
    // is always present, for the reason above), so the workflow-count check never ran and the
    // gate reproduced the exact unsatisfiable-forever bug it was built to close. Confirmed
    // live: zero of a random sample of generated repos ever had a merged publish PR since this
    // gate shipped.
    //
    // Dropping the length check entirely (an earlier version of this fix) was too broad: Vercel's
    // own app is itself proof that a check CAN appear here without a human wiring up CI, and
    // nothing currently blocks a `.circleci/`-style config from landing in one of these repos via
    // the chat-editing routes (only `.github/` is blocked there) — so "no other check can ever
    // exist" is not something this code actually guarantees. Filtering out the one KNOWN-benign
    // source by identity, rather than trusting `checkRuns.length` at all, keeps protection against
    // any other real check while still closing the confirmed bug.
    //
    // FAIL CLOSED still holds: the workflow count is consulted only when nothing OTHER than the
    // known-benign check has reported, and any error leaves it non-zero so the gate applies.
    // "Could not determine whether this repo has CI" must never be read as "it has none".
    let noCiAtAll = false;
    if (!testsCheck && nonBenignCheckRuns.length === 0) {
      let workflowCount = 1;
      try {
        const workflowsRes = await axios.get<any>(`${repoBase}/actions/workflows`, {
          headers: ghHeaders,
          timeout: GITHUB_TIMEOUT_MS,
        });
        workflowCount = workflowsRes.data?.total_count ?? 1;
      } catch (wfErr: any) {
        console.warn(
          `[LP GENERATION] Could not list workflows for ${owner}/${repoName}; ` +
            `keeping the required-Tests gate: ${wfErr.message}`
        );
      }
      noCiAtAll = workflowCount === 0;
    }

    if (noCiAtAll) {
      console.log(
        `[LP GENERATION] ${owner}/${repoName} reported no check runs and no workflows, so no ` +
          `Tests check can exist — the required-Tests gate does not apply to this publish.`
      );
    } else {
      // ENG-2794: decision lives in services/publishGateVerifier so the verifier harness
      // exercises the exact same gate logic.
      const gate = evaluateRequiredTestsGate(testsCheck, false);
      if (!gate.allow) {
        return res.status(gate.status).json({ error: gate.error, message: gate.message });
      }
    }

    // A Tests result belongs only to the SHA inspected above. Pin every later
    // main-advancing operation to that SHA and refuse if the draft moved while
    // the check was running; the newer commit needs its own Tests result.
    const checkedDraftRefRes = await axios.get<any>(
      `${repoBase}/git/ref/heads/${encodeURIComponent(branch)}`,
      { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
    );
    if (checkedDraftRefRes.data.object.sha !== draftSha) {
      return res.status(409).json({
        error: "draft_changed_after_tests",
        message: "The draft changed after its Tests check ran. Keep the newer draft and retry publish after Tests passes for its new commit.",
      });
    }

    if (await refuseIfConsentWithdrawn()) return;

    try {
      const mergeRes = await axios.post<any>(
        `${repoBase}/merges`,
        {
          base: "main",
          head: draftSha,
          commit_message: `Publish landing page changes from ${branch}`,
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      mergeCommitSha = mergeRes.data.sha;
      console.log(`[LP GENERATION] Merged ${branch} into main: ${mergeCommitSha?.substring(0, 7)}`);
    } catch (mergeErr: any) {
      if (mergeErr.response?.status !== 409) throw mergeErr;

      // Force-advancing main to the draft tip is only safe when the draft already
      // contains every main commit. If main moved on since the draft was cut, a force
      // update silently reverts those commits (other pages, manual PRs) in production.
      try {
        const cmp = await axios.get<any>(
          `${repoBase}/compare/${draftSha}...main`,
          { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
        );
        if (Number(cmp.data?.ahead_by) > 0) {
          return res.status(409).json({
            error: "draft_behind_main",
            message: `The draft is missing ${cmp.data.ahead_by} commit(s) that are already on main and conflicts with them. Publishing would revert live changes. Re-run the edit so it is rebuilt on current main.`,
          });
        }
      } catch (cmpErr: any) {
        return res.status(409).json({
          error: "draft_divergence_unknown",
          message: "Could not confirm the draft contains main; refusing to force-publish.",
        });
      }

      console.warn(`[LP GENERATION] Standard merge returned 409; fast-forwarding main to draft branch tip`);

      // The post-Tests ref read above proved that this exact SHA is still the
      // draft tip. Use that immutable SHA here, never a newer untested branch tip.
      if (await refuseIfConsentWithdrawn()) return;

      // Fast-forward main to the tested draft SHA. force:false makes GitHub reject
      // the update if main advanced between the compare above and this PATCH.
      await axios.patch<any>(
        `${repoBase}/git/refs/heads/main`,
        { sha: draftSha, force: false },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      mergeCommitSha = draftSha;
      console.log(`[LP GENERATION] Force-advanced main to draft tip ${draftSha.substring(0, 7)}`);
    }

    // Delete the draft branch
    try {
      const deleteRefRes = await axios.get<any>(
        `${repoBase}/git/ref/heads/${encodeURIComponent(branch)}`,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      if (deleteRefRes.data.object.sha !== draftSha) {
        console.warn(`[LP GENERATION] Preserved newer draft branch ${branch} after publish`);
      } else {
        await axios.delete(`${repoBase}/git/refs/heads/${branch}`, {
          headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS,
        });
        console.log(`[LP GENERATION] Deleted branch ${branch}`);
      }
    } catch (delErr: any) {
      console.warn(`[LP GENERATION] Could not delete branch ${branch}: ${delErr.message}`);
    }

    // Trigger a Vercel deployment — GitHub API merges don't always trigger the webhook
    if (page.vercelProjectId) {
      try {
        await triggerVercelDeployment(page.vercelProjectId, `${owner}/${repoName}`);
      } catch (deployErr: any) {
        console.warn(`[LP GENERATION] Could not trigger Vercel deployment after publish: ${deployErr.message}`);
      }
    }

    // Record what we need to revert this publish (exact pre-merge state).
    // Only possible when the pre-merge SHA was captured and actually changed.
    if (preMergeSha && preMergeSha !== mergeCommitSha) {
      try {
        await recordLandingPagePublish(page.id, {
          preMergeSha,
          mergeSha: mergeCommitSha,
          branch,
          publishedAt: new Date().toISOString(),
        });
      } catch (recErr: any) {
        console.warn(`[LP GENERATION] Could not record publish history: ${recErr.message}`);
      }
    }

    const liveUrl = await resolveLandingPageLiveUrl(page);
    void emitLanderLifecycle("published", { pageId: page.id, userId: (req as unknown as AuthenticatedRequest).user?.userId, channel: landerChannelFromRequest(req) });
    res.json({
      success: true,
      merge_commit_sha: mergeCommitSha,
      live_url: liveUrl,
      deployed_url: page.deployedUrl,
      message: `Changes from ${branch} have been published to main. Your site at ${liveUrl} will update shortly.`,
    });
  } catch (error: any) {
    const ghStatus = error.response?.status;
    const ghMessage = error.response?.data?.message || error.message;
    console.error(`[LP GENERATION] Error publishing branch (HTTP ${ghStatus}):`, ghMessage);

    if (ghStatus === 404) {
      res.status(404).json({ error: "Branch not found. It may have already been merged or deleted." });
    } else {
      res.status(500).json({ error: `Failed to publish: ${ghMessage}` });
    }
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/revert-publish
 * Undo the most recent publish by force-resetting main back to the SHA it
 * pointed at before that publish merged. This is the inverse of /publish and
 * relies on the `lastPublish` state recorded at publish time. Re-deploys Vercel.
 */
router.post("/generated/:id/revert-publish", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "No GitHub repository" });

    const lastPublish = page.lastPublish;
    if (!lastPublish || !lastPublish.preMergeSha) {
      return res.status(400).json({
        error: "Nothing to revert — no recorded publish for this landing page.",
      });
    }
    if (lastPublish.revertedAt) {
      return res.status(400).json({
        error: "The last publish has already been reverted.",
      });
    }

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    const [, owner, repo] = repoMatch;
    const repoName = repo.replace('.git', '');
    const { getGitHubOrgToken } = await import("../utils/secretsManager");
    const { token } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    };
    const GITHUB_TIMEOUT_MS = 30_000;
    const repoBase = `https://api.github.com/repos/${owner}/${repoName}`;

    // Safety: only revert if main is still at the commit this publish produced.
    // If something newer was published or pushed, main has moved on and a blind
    // reset would silently discard that newer work — refuse instead.
    const mainRefRes = await axios.get<any>(
      `${repoBase}/git/ref/heads/main`,
      { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
    );
    const currentMainSha: string = mainRefRes.data.object.sha;
    if (currentMainSha !== lastPublish.mergeSha) {
      return res.status(409).json({
        error:
          "Cannot revert — main has changed since the last publish (newer changes were published). " +
          "Reverting would discard those changes.",
      });
    }

    // Force-reset main back to the pre-merge SHA. Safe for these system-managed
    // repos (no external contributors) — same primitive publish uses to advance main.
    await axios.patch<any>(
      `${repoBase}/git/refs/heads/main`,
      { sha: lastPublish.preMergeSha, force: true },
      { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
    );
    console.log(
      `[LP GENERATION] Reverted main to pre-publish ${lastPublish.preMergeSha.substring(0, 7)} (was ${lastPublish.mergeSha.substring(0, 7)})`
    );

    // Trigger a Vercel deployment so the live site reflects the revert.
    if (page.vercelProjectId) {
      try {
        await triggerVercelDeployment(page.vercelProjectId, `${owner}/${repoName}`);
      } catch (deployErr: any) {
        console.warn(`[LP GENERATION] Could not trigger Vercel deployment after revert: ${deployErr.message}`);
      }
    }

    // Mark the publish consumed so it can't be reverted twice.
    try {
      await markLandingPagePublishReverted(page.id, new Date().toISOString());
    } catch (markErr: any) {
      console.warn(`[LP GENERATION] Could not mark publish reverted: ${markErr.message}`);
    }

    void emitLanderLifecycle("publish_reverted", { pageId: page.id, userId: (req as unknown as AuthenticatedRequest).user?.userId, channel: landerChannelFromRequest(req) });
    res.json({
      success: true,
      reverted_to_sha: lastPublish.preMergeSha,
      deployed_url: page.deployedUrl,
      message: `Reverted the last publish. Your site at ${page.deployedUrl} will update shortly.`,
    });
  } catch (error: any) {
    const ghStatus = error.response?.status;
    const ghMessage = error.response?.data?.message || error.message;
    console.error(`[LP GENERATION] Error reverting publish (HTTP ${ghStatus}):`, ghMessage);

    if (ghStatus === 404) {
      res.status(404).json({ error: "Repository or branch not found." });
    } else {
      res.status(500).json({ error: `Failed to revert: ${ghMessage}` });
    }
  }
});

/**
 * POST /api/landing-pages/v0/generated/:id/gtm
 * Inject a Google Tag Manager container into the root layout.tsx of the
 * page's GitHub repo and persist the container ID in DynamoDB.
 *
 * Body: { gtmContainerId: string }  — e.g. "GTM-XXXXXX"
 *
 * The handler:
 *  1. Reads the current app/layout.tsx from GitHub
 *  2. Inserts the GTM <head> snippet + <noscript> body snippet (idempotent —
 *     removes any existing GTM block first)
 *  3. Commits the updated file to the main branch (triggers Vercel re-deploy)
 *  4. Saves gtmContainerId on the DynamoDB record
 */
router.post("/generated/:id/gtm", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "Landing page has no GitHub repository" });

    const { gtmContainerId } = req.body as { gtmContainerId?: string };
    if (!gtmContainerId || typeof gtmContainerId !== "string") {
      return res.status(400).json({ error: "gtmContainerId is required" });
    }
    // Validate GTM container ID format
    if (!/^GTM-[A-Z0-9]{4,10}$/.test(gtmContainerId.trim())) {
      return res.status(400).json({ error: "Invalid GTM container ID. Expected format: GTM-XXXXXXX" });
    }
    const containerId = gtmContainerId.trim();

    const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!repoMatch) return res.status(400).json({ error: "Invalid GitHub repo URL" });

    await saveGtmForPage(page, containerId);

    res.json({ success: true, gtmContainerId: containerId, message: `GTM container ${containerId} injected. Your site will redeploy shortly.` });
  } catch (error: any) {
    console.error("[LP GENERATION] Error injecting GTM:", error);
    const httpStatus = error?.httpStatus ?? 500;
    res.status(httpStatus).json({ error: error.response?.data?.message || error.message || "Failed to inject GTM" });
  }
});

/**
 * GET /api/landing-pages/v0/generated/:id/preview-url
 * Get the Vercel preview deployment URL for a draft branch.
 */
router.get("/generated/:id/preview-url", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;

    const vercelProjectId = await resolveVercelProjectId(page);
    if (!vercelProjectId) return res.status(400).json({ error: "No Vercel project" });

    const branch = req.query.branch as string;
    if (!branch || branch === "main") {
      return res.status(400).json({ error: "A draft branch name is required (not 'main')" });
    }
    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name" });
    }

    const commitSha = req.query.commitSha;
    if (commitSha !== undefined && (typeof commitSha !== 'string' || !/^[a-f0-9]{40}$/i.test(commitSha))) {
      return res.status(400).json({ error: 'Invalid commit SHA' });
    }
    const result = await getPreviewDeploymentUrl(vercelProjectId, branch, commitSha);
    res.json(result);
  } catch (error: any) {
    console.error("[LP GENERATION] Error getting preview URL:", error);
    res.status(500).json({ error: error.message || "Failed to get preview URL" });
  }
});

// ---------------------------------------------------------------------------
// Helper: load integrations payload for a given page (no auth check).
// Returns the same shape as GET /generated/:id/integrations.
// ---------------------------------------------------------------------------
async function loadIntegrationsForPage(page: GeneratedLandingPage): Promise<{
  recaptcha: { siteKey: string; secretKeyIsSet: boolean };
  custom: Array<{ key: string; value: string; id?: string; secret?: boolean }>;
}> {
  const vercelProjectId = await resolveVercelProjectId(page);
  if (!vercelProjectId) {
    return { recaptcha: { siteKey: "", secretKeyIsSet: false }, custom: [] };
  }

  const envMap = await getProjectEnvVars(vercelProjectId);
  const cfg = INTEGRATIONS.recaptcha;
  const siteKeyEntry = envMap[cfg.siteKey.envKey];
  const secretKeyEntry = envMap[cfg.secretKey.envKey];

  // All known integration env var keys
  const knownKeys = new Set<string>([cfg.siteKey.envKey, cfg.secretKey.envKey]);

  // Custom env vars: anything not in a known integration
  const custom = Object.entries(envMap)
    .filter(([key]) => !knownKeys.has(key))
    .map(([key, entry]) => ({ key, value: entry.value, id: entry.id, secret: entry.type === "encrypted" }));

  return {
    recaptcha: {
      siteKey: siteKeyEntry?.value ?? "",
      secretKeyIsSet: !!secretKeyEntry?.id,
    },
    custom,
  };
}

// ---------------------------------------------------------------------------
// Helper: save integrations for a given page (no auth check).
// Upserts/deletes env vars on the Vercel project and triggers a redeployment.
// Returns the list of env var keys that were touched.
// Throws if the page has no Vercel project.
// ---------------------------------------------------------------------------
async function saveIntegrationsForPage(
  page: GeneratedLandingPage,
  body: {
    recaptcha?: { siteKey?: string; secretKey?: string };
    custom?: Array<{ key: string; value: string; secret?: boolean; id?: string; _delete?: boolean }>;
  },
): Promise<{ updated: string[] }> {
  const vercelProjectId = await resolveVercelProjectId(page);
  if (!vercelProjectId) {
    throw new Error("Landing page has no Vercel project — deploy it first");
  }

  const { recaptcha, custom } = body;

  const envMap = await getProjectEnvVars(vercelProjectId);
  const updated: string[] = [];
  const allTargets = ["production", "preview", "development"];

  if (recaptcha) {
    const cfg = INTEGRATIONS.recaptcha;

    if (recaptcha.siteKey !== undefined) {
      const existing = envMap[cfg.siteKey.envKey];
      if (recaptcha.siteKey === "") {
        if (existing?.ids) await Promise.all(existing.ids.map(id => deleteEnvVar(vercelProjectId, id)));
      } else {
        await upsertEnvVar(vercelProjectId, cfg.siteKey.envKey, recaptcha.siteKey, cfg.siteKey.target as string[], existing?.ids, cfg.siteKey.type);
      }
      updated.push(cfg.siteKey.envKey);
    }

    if (recaptcha.secretKey !== undefined) {
      const existing = envMap[cfg.secretKey.envKey];
      if (recaptcha.secretKey === "") {
        if (existing?.ids) await Promise.all(existing.ids.map(id => deleteEnvVar(vercelProjectId, id)));
      } else {
        await upsertEnvVar(vercelProjectId, cfg.secretKey.envKey, recaptcha.secretKey, cfg.secretKey.target as string[], existing?.ids, cfg.secretKey.type);
      }
      updated.push(cfg.secretKey.envKey);
    }
  }

  if (Array.isArray(custom)) {
    for (const entry of custom) {
      if (!entry.key) continue;
      if (entry._delete) {
        const existing = entry.id ? { ids: [entry.id] } : envMap[entry.key];
        if (existing?.ids) await Promise.all(existing.ids.map(id => deleteEnvVar(vercelProjectId, id)));
      } else {
        const existing = envMap[entry.key];
        await upsertEnvVar(vercelProjectId, entry.key, entry.value, allTargets, existing?.ids, entry.secret ? "encrypted" : "plain");
      }
      updated.push(entry.key);
    }
  }

  // Trigger a redeployment so the new env vars take effect
  if (updated.length > 0 && page.githubRepoUrl) {
    try {
      const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (repoMatch) {
        const [, owner, repo] = repoMatch;
        await triggerVercelDeployment(vercelProjectId, `${owner}/${repo.replace(".git", "")}`);
      }
    } catch (deployErr: any) {
      console.warn(`[LP GENERATION] Could not trigger redeployment after env var update: ${deployErr.message}`);
    }
  }

  return { updated };
}

// ---------------------------------------------------------------------------
// GET /generated/:id/integrations
// Returns current integration values for the page's Vercel project.
// Secret key values are never returned — only a boolean "isSet" flag.
// ---------------------------------------------------------------------------
router.get("/generated/:id/integrations", editRateLimiter, async (req: Request, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;

    const payload = await loadIntegrationsForPage(page);
    res.json(payload);
  } catch (error: any) {
    console.error("[LP GENERATION] Error getting integrations:", error);
    res.status(500).json({ error: error.message || "Failed to get integrations" });
  }
});

// ---------------------------------------------------------------------------
// PUT /generated/:id/integrations
// Upserts integration env vars on the page's Vercel project.
// Pass empty string for a field to delete that env var; omit to leave untouched.
// ---------------------------------------------------------------------------
router.put("/generated/:id/integrations", editRateLimiter, async (req: Request, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;

    if (typeof req.body !== "object" || req.body == null) {
      return res.status(400).json({ error: "Invalid body" });
    }

    try {
      const { updated } = await saveIntegrationsForPage(page, req.body);
      res.json({ success: true, updated });
    } catch (saveErr: any) {
      if (saveErr.message?.includes("no Vercel project")) {
        return res.status(400).json({ error: saveErr.message });
      }
      throw saveErr;
    }
  } catch (error: any) {
    console.error("[LP GENERATION] Error updating integrations:", error);
    res.status(500).json({ error: error.message || "Failed to update integrations" });
  }
});

// ---------------------------------------------------------------------------
// Helper: inject GTM into a page's layout.tsx and persist the container ID.
// Does NOT do auth checks — callers must authorize before calling.
// ---------------------------------------------------------------------------
async function saveGtmForPage(
  page: GeneratedLandingPage,
  containerId: string,
): Promise<void> {
  if (!page.githubRepoUrl) throw new Error("Landing page has no GitHub repository");

  const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error("Invalid GitHub repo URL");
  const [, owner, repoRaw] = repoMatch;
  const repo = repoRaw.replace(".git", "");

  const { getGitHubOrgToken } = await import("../utils/secretsManager");
  const { token } = await getGitHubOrgToken();
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };
  const GITHUB_TIMEOUT_MS = 30_000;
  const repoBase = `https://api.github.com/repos/${owner}/${repo}`;

  // 1–4. Fetch layout.tsx, derive updated content, and commit — with up to 3 attempts
  //       to handle GitHub SHA race conditions (409 Conflict).
  const layoutPath = "app/layout.tsx";
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 1. Fetch current layout.tsx (inside loop so each retry gets a fresh SHA)
      let currentContent = "";
      let fileSha: string | undefined;
      const fileRes = await axios.get<any>(`${repoBase}/contents/${layoutPath}`, {
        headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS,
      });
      currentContent = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
      fileSha = fileRes.data.sha;

      // 2–3. Strip any existing GTM block and re-inject (idempotent). Shared with the
      //       auto-inject-at-generation path so both emit byte-identical output (ENG-334).
      const updatedContent = injectGtmIntoLayout(currentContent, containerId);

      // Fail loud, not silent: a layout with neither <head> nor <body> to anchor on leaves
      // injectGtmIntoLayout's insertion a no-op. Without this check we'd commit unchanged
      // content to GitHub and still tell the caller "success" with the container ID they
      // asked for — a manual Add-GTM click that silently did nothing.
      if (!verifyGtmInjection(updatedContent, containerId)) {
        // Log the precise technical reason for debugging, but never surface "layout.tsx" /
        // "<head>" / "<body>" to the customer — they can't act on that, and it's not
        // anything they did wrong. The message that reaches the UI must be something a
        // non-technical marketer can actually read and act on.
        console.error(
          `[LP GENERATION] GTM ${containerId ? "injection" : "removal"} verification failed ` +
          `for page ${page.id}: layout.tsx has no <head> or <body> tag to anchor on.`,
        );
        throw Object.assign(
          new Error(
            containerId
              ? "We couldn't add tracking to this page automatically. Try regenerating the page, or contact support if this keeps happening."
              : "We couldn't remove tracking from this page automatically. Try regenerating the page, or contact support if this keeps happening.",
          ),
          { httpStatus: 422 },
        );
      }

      // 4. Commit updated layout.tsx to GitHub
      const base64New = Buffer.from(updatedContent, "utf-8").toString("base64");
      await axios.put<any>(
        `${repoBase}/contents/${layoutPath}`,
        {
          message: containerId ? `chore: inject GTM container ${containerId}` : "chore: remove GTM container",
          content: base64New,
          sha: fileSha,
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      break; // success — exit retry loop
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        throw Object.assign(new Error("app/layout.tsx not found in the repository"), { httpStatus: 400 });
      }
      if (status === 409 && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }

  // 5. Persist gtmContainerId in DynamoDB
  await updateLandingPageGtm(page.id, page.userId, containerId);

  // The layout we just committed is the SHARED root layout every page on this site inherits
  // — so every sibling page (root + subpages) just became tracked (or untracked) on the live
  // site, not just `page`. Sync trackingInstalled across all of them so the customer-portal
  // warning badge doesn't stay stuck forever after the user correctly fixes it via Site
  // Settings (a real gap this shipped with: the advice was always correct, only our own
  // stored flag went stale). Best-effort per page — a sync failure must never undo the
  // GitHub commit that already succeeded, so failures are logged and skipped, not thrown.
  const siteId = page.siteId ?? page.id;
  try {
    const siblings = await listLandingPages(page.userId);
    await Promise.all(
      siblings
        .filter((p) => (p.siteId ?? p.id) === siteId)
        .map((p) =>
          updateLandingPageTrackingInstalled(p.id, !!containerId).catch((err: any) => {
            console.error(`[LP GENERATION] Failed to sync trackingInstalled for page ${p.id}: ${err.message}`);
          }),
        ),
    );
  } catch (err: any) {
    console.error(`[LP GENERATION] Failed to list sibling pages for trackingInstalled sync: ${err.message}`);
  }

  // Trigger Vercel re-deploy if we have a project ID
  const vercelProjectId = await resolveVercelProjectId(page);
  if (vercelProjectId) {
    try {
      await triggerVercelDeployment(vercelProjectId, `${owner}/${repo}`);
    } catch (deployErr: any) {
      console.warn(`[LP GENERATION] Could not trigger Vercel re-deploy after GTM inject: ${deployErr.message}`);
    }
  }
}

/**
 * Install (or remove) the Google Ads base tag in a page's shared root layout, persist the
 * conversion config, and redeploy. Mirrors `saveGtmForPage` step for step, including the
 * 409-retry loop around GitHub's SHA race and the sibling sync.
 *
 * The sibling sync is not optional bookkeeping. The base tag lives in the SHARED root
 * layout, so this one commit changes the answer for every page on the site. Leaving the
 * other records stale would have RULE 7.5 refuse a launch on a page that is, in fact,
 * measurable — which trains people to reach for override_tracking_check.
 */
async function saveGoogleAdsForPage(
  page: GeneratedLandingPage,
  conversionId: string,
  conversionLabel?: string,
  customerId?: string,
): Promise<void> {
  if (!page.githubRepoUrl) throw new Error("Landing page has no GitHub repository");

  const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error("Invalid GitHub repo URL");
  const [, owner, repoRaw] = repoMatch;
  const repo = repoRaw.replace(".git", "");

  const { getGitHubOrgToken } = await import("../utils/secretsManager");
  const { token } = await getGitHubOrgToken();
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };
  const GITHUB_TIMEOUT_MS = 30_000;
  const repoBase = `https://api.github.com/repos/${owner}/${repo}`;
  const layoutPath = "app/layout.tsx";
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Fetched inside the loop so each retry gets a fresh SHA.
      const fileRes = await axios.get<any>(`${repoBase}/contents/${layoutPath}`, {
        headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS,
      });
      const currentContent = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
      const fileSha = fileRes.data.sha;

      // Already exactly right? Then there is nothing to commit. Check this SEMANTICALLY,
      // not by comparing bytes before and after: strip-then-reinject is idempotent in
      // effect but not byte-for-byte — when the block sits flush against the next tag a
      // newline shifts on the second pass — so a byte compare would push a pointless
      // commit and a full Vercel rebuild on every repeat click.
      if (conversionId && verifyGoogleAdsInjection(currentContent, conversionId)) {
        break;
      }

      const updatedContent = injectGoogleAdsIntoLayout(currentContent, conversionId);

      // Fail loud, not silent: a layout with no <head>/<body> anchor leaves the insertion a
      // no-op, and without this we would commit unchanged content and still report success
      // for a tag that was never installed.
      if (!verifyGoogleAdsInjection(updatedContent, conversionId)) {
        console.error(
          `[LP GENERATION] Google Ads ${conversionId ? "injection" : "removal"} verification failed ` +
          `for page ${page.id}: layout.tsx has no <head> or <body> tag to anchor on.`,
        );
        // The technical reason is logged, never surfaced: a marketer cannot act on
        // "<head>", and it is not anything they did wrong.
        throw Object.assign(
          new Error(
            conversionId
              ? "We couldn't add Google Ads tracking to this page automatically. Try regenerating the page, or contact support if this keeps happening."
              : "We couldn't remove Google Ads tracking from this page automatically. Try regenerating the page, or contact support if this keeps happening.",
          ),
          { httpStatus: 422 },
        );
      }

      // Nothing to commit when the layout already says exactly this. Saves a pointless
      // Vercel rebuild on a repeat click, which the idempotent injection makes common.
      if (updatedContent !== currentContent) {
        await axios.put<any>(
          `${repoBase}/contents/${layoutPath}`,
          {
            message: conversionId
              ? `chore: install Google Ads tag ${conversionId}`
              : "chore: remove Google Ads tag",
            content: Buffer.from(updatedContent, "utf-8").toString("base64"),
            sha: fileSha,
          },
          { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
        );
      }
      break;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        throw Object.assign(new Error("app/layout.tsx not found in the repository"), { httpStatus: 400 });
      }
      if (status === 409 && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }

  /*
   * Write the config to EVERY page of the site, not just the one named in the request.
   *
   * A conversion is site-wide by construction — the base tag lives in the shared root
   * layout we just committed — so one commit changed the answer for every page. Writing
   * only to `page` breaks in both directions: a manual install targeting a SUB-page would
   * leave the ROOT blank, and addSubPage reads the pair off the root, so every later
   * sub-page would inherit nothing and capture leads that fire no conversion. Writing to
   * all of them also keeps each record self-describing, which is what lets RULE 7.5 and
   * the offline import (ENG-1325) read the config off ANY page without walking to a root.
   *
   * Best-effort per page — a sync failure must never undo the GitHub commit that already
   * succeeded. The root is written first and NOT swallowed: it is the record addSubPage
   * inherits from, so losing it silently is the one failure that propagates.
   */
  const siteId = page.siteId ?? page.id;
  await updateLandingPageGoogleAds(siteId, page.userId, conversionId, conversionLabel, customerId);

  try {
    const siblings = await listLandingPages(page.userId);
    await Promise.all(
      siblings
        .filter((p) => (p.siteId ?? p.id) === siteId)
        .map(async (p) => {
          try {
            if (p.id !== siteId) {
              await updateLandingPageGoogleAds(p.id, p.userId, conversionId, conversionLabel, customerId);
            }
            await updateLandingPageGoogleAdsInstalled(p.id, !!conversionId);
          } catch (err: any) {
            console.error(`[LP GENERATION] Failed to sync Google Ads config for page ${p.id}: ${err.message}`);
          }
        }),
    );
  } catch (err: any) {
    console.error(`[LP GENERATION] Failed to list sibling pages for Google Ads sync: ${err.message}`);
  }

  const vercelProjectId = await resolveVercelProjectId(page);
  if (vercelProjectId) {
    try {
      await triggerVercelDeployment(vercelProjectId, `${owner}/${repo}`);
    } catch (deployErr: any) {
      console.warn(`[LP GENERATION] Could not trigger Vercel re-deploy after Google Ads inject: ${deployErr.message}`);
    }
  }
}

/**
 * POST /api/landing-pages/v0/generated/:id/google-ads
 * Install the Google Ads base tag in the root layout.tsx of the page's GitHub repo and
 * persist the conversion config. The manual counterpart to /gtm and /meta-pixel, and the
 * third seam ENG-1328 needs — this is the path a customer uses when the conversion action
 * is created after the site was generated.
 *
 * Body: { googleAdsConversionId: string, googleAdsConversionLabel?: string,
 *         googleAdsCustomerId?: string }
 *
 * Send an empty googleAdsConversionId to REMOVE the tag — the injection strips before it
 * inserts, so removal is the same code path.
 */
router.post("/generated/:id/google-ads", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "Landing page has no GitHub repository" });

    const { googleAdsConversionId, googleAdsConversionLabel, googleAdsCustomerId } = req.body as {
      googleAdsConversionId?: string; googleAdsConversionLabel?: string; googleAdsCustomerId?: string;
    };
    if (typeof googleAdsConversionId !== "string") {
      return res.status(400).json({ error: "googleAdsConversionId is required (send an empty string to remove)" });
    }
    const conversionId = googleAdsConversionId.trim();
    // Same shape RULE 7.5's detector looks for, so a tag we install is a tag the
    // pre-flight gate will actually recognise on the served page.
    if (conversionId && !/^AW-[0-9]{6,}$/.test(conversionId)) {
      return res.status(400).json({ error: "Invalid Google Ads conversion ID. Expected format: AW-123456789" });
    }
    // Rejected, not coerced. A non-string label silently became `undefined`, which
    // updateLandingPageGoogleAds reads as "clear the stored label" — so a malformed
    // request would strip a working conversion pair and leave an id that attributes
    // nothing. A non-string customer id reached .trim() and 500'd.
    if (googleAdsConversionLabel !== undefined && typeof googleAdsConversionLabel !== "string") {
      return res.status(400).json({ error: "googleAdsConversionLabel must be a string" });
    }
    if (googleAdsCustomerId !== undefined && typeof googleAdsCustomerId !== "string") {
      return res.status(400).json({ error: "googleAdsCustomerId must be a string" });
    }
    const label = typeof googleAdsConversionLabel === "string" ? googleAdsConversionLabel.trim() : undefined;
    // The label is not needed to INSTALL the base tag, but without it no conversion can
    // ever be attributed — so this is a warning on the response, not a refusal.
    const warning = conversionId && !label
      ? "Base tag installed, but no conversion label was provided — conversions cannot be attributed until one is set."
      : undefined;

    // ENG-1525: `|| undefined` collapsed an explicit `""` (clear this) into "not
    // mentioned", which is the distinction updateLandingPageGoogleAds now relies on.
    // Same shape as `label` two lines up.
    const customerId = typeof googleAdsCustomerId === "string" ? googleAdsCustomerId.trim() : undefined;
    await saveGoogleAdsForPage(page, conversionId, label, customerId);

    res.json({
      success: true,
      googleAdsConversionId: conversionId,
      ...(label ? { googleAdsConversionLabel: label } : {}),
      ...(warning ? { warning } : {}),
      message: conversionId
        ? `Google Ads tag ${conversionId} installed. Your site will redeploy shortly.`
        : "Google Ads tag removed. Your site will redeploy shortly.",
    });
  } catch (error: any) {
    console.error("[LP GENERATION] Error installing Google Ads tag:", error);
    const httpStatus = error?.httpStatus ?? 500;
    res.status(httpStatus).json({ error: error.response?.data?.message || error.message || "Failed to install Google Ads tag" });
  }
});

// ---------------------------------------------------------------------------
// Helper: inject a Meta pixel into a page's layout.tsx + regenerate its capture
// route with the pixel/account id baked in, and persist the pixel id.
// Manual override path (API-only — no portal UI, per confirmed scope) for when
// auto-resolution (metaService.resolveMetaPixelForUser) can't determine a pixel,
// or a customer needs a different one than the one auto-resolved.
// Does NOT do auth checks — callers must authorize before calling.
// ---------------------------------------------------------------------------
async function saveMetaPixelForPage(
  page: GeneratedLandingPage,
  pixelId: string,
  accountId?: string,
): Promise<string | undefined> {
  if (!page.githubRepoUrl) throw new Error("Landing page has no GitHub repository");

  const repoMatch = page.githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error("Invalid GitHub repo URL");
  const [, owner, repoRaw] = repoMatch;
  const repo = repoRaw.replace(".git", "");
  const repoFullName = `${owner}/${repo}`;

  const { getGitHubOrgToken } = await import("../utils/secretsManager");
  const { token } = await getGitHubOrgToken();
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" };
  const GITHUB_TIMEOUT_MS = 30_000;
  const repoBase = `https://api.github.com/repos/${owner}/${repo}`;

  // 1. Inject/strip the pixel base snippet in app/layout.tsx — same retry-on-409 pattern
  //    as saveGtmForPage, and the SAME shared util the auto-inject-at-generation path uses.
  const layoutPath = "app/layout.tsx";
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const fileRes = await axios.get<any>(`${repoBase}/contents/${layoutPath}`, {
        headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS,
      });
      const currentContent = Buffer.from(fileRes.data.content, "base64").toString("utf-8");
      const fileSha = fileRes.data.sha;

      const updatedContent = injectPixelIntoLayout(currentContent, pixelId);

      if (!verifyPixelInjection(updatedContent, pixelId)) {
        console.error(
          `[LP GENERATION] Meta Pixel ${pixelId ? "injection" : "removal"} verification failed ` +
          `for page ${page.id}: layout.tsx has no <head> or <body> tag to anchor on.`,
        );
        throw Object.assign(
          new Error(
            pixelId
              ? "We couldn't add Meta Pixel tracking to this page automatically. Try regenerating the page, or contact support if this keeps happening."
              : "We couldn't remove Meta Pixel tracking from this page automatically. Try regenerating the page, or contact support if this keeps happening.",
          ),
          { httpStatus: 422 },
        );
      }

      const base64New = Buffer.from(updatedContent, "utf-8").toString("base64");
      await axios.put<any>(
        `${repoBase}/contents/${layoutPath}`,
        {
          message: pixelId ? `chore: inject Meta Pixel ${pixelId}` : "chore: remove Meta Pixel",
          content: base64New,
          sha: fileSha,
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      break;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) {
        throw Object.assign(new Error("app/layout.tsx not found in the repository"), { httpStatus: 400 });
      }
      if (status === 409 && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }

  // 2. Regenerate the repo's capture route with the new PIXEL_ID/META_ACCOUNT_ID baked in —
  //    unlike GTM, the pixel id must also reach app/api/capture/route.ts so forward-lead can
  //    fire the matching server-side CAPI event. Build the whole-site path->list map the same
  //    way syncLeadCaptureForPage does (the capture route is repo-level, the list is per-page).
  //
  //    ENG-485: re-derived FRESH by syncLeadCaptureFilesToRepo on every retry attempt, not
  //    just once here — see that function's own doc comment on why a static snapshot isn't
  //    safe to reuse across a rebase retry.
  const buildListByPath = async (): Promise<Record<string, string>> => {
    const siblings = await listLandingPages(page.userId);
    const listByPath: Record<string, string> = {};
    for (const p of siblings) {
      if (p.githubRepoUrl !== page.githubRepoUrl) continue;
      if (!p.leadListId) continue;
      listByPath[p.slug ? `/${p.slug}` : "/"] = p.leadListId;
    }
    return listByPath;
  };
  const captureSync = await syncLeadCaptureFilesToRepo(
    repoFullName,
    buildListByPath,
    pixelId || undefined,
    pixelId ? accountId : undefined,
  );
  // The base pixel snippet goes into the layout regardless, but the SERVER-side half lives in
  // the capture route — and on a repo the platform does not own we refuse to write it. Saying
  // "Meta Pixel injected" here would report full tracking while CAPI was never configured.
  // ⚠ `!committed &&` is load-bearing, not defensive noise: a successful sync carries
  // `reason: undefined`, and in any suite that mocks v0Service with an object literal the
  // imported NO_CAPTURE_LAYER is ALSO undefined — so a bare equality would fire this warning
  // on every successful pixel install under test.
  // ⚠ Two distinct silent-partials, and `committed` alone catches neither:
  //   - the floor refused the repo outright (NO_CAPTURE_LAYER, committed:false)
  //   - the commit landed but deliberately EXCLUDED the capture route (captureRouteSkipped)
  // Either way the requested pixel is not in the capture route, so "Meta Pixel injected" on
  // its own would claim server-side tracking that does not exist.
  const verb = pixelId ? "updated" : "removed";
  const captureWarning =
    !captureSync.committed && captureSync.reason === NO_CAPTURE_LAYER
      ? `The browser pixel was ${verb}, but this site does not use the platform's lead-capture ` +
        "code, so server-side conversion tracking was not configured for it. Wire it in the " +
        "site's own repository."
      : captureSync.captureRouteSkipped
        ? `The browser pixel was ${verb}, but this site's lead-capture route could not be read, ` +
          "so it was left exactly as deployed and does not carry this change. Fix the route in " +
          "the site's repository."
        : undefined;

  // 3. Persist metaPixelId/metaAdAccountId on this record.
  await updateLandingPageMetaPixel(page.id, page.userId, pixelId, accountId);

  // 4. Sync metaTrackingInstalled across every sibling sharing this site's root layout —
  //    same rationale as saveGtmForPage's trackingInstalled sync. Best-effort; a sync
  //    failure must never undo the GitHub commit that already succeeded. Its own fresh
  //    query (ENG-485 moved the capture-route map's own siblings lookup into a re-callable
  //    closure above) — this one is unrelated to the race that closure exists to fix.
  const siteId = page.siteId ?? page.id;
  try {
    const siblingsForTrackingSync = await listLandingPages(page.userId);
    await Promise.all(
      siblingsForTrackingSync
        .filter((p) => (p.siteId ?? p.id) === siteId)
        .map((p) =>
          updateLandingPageMetaTrackingInstalled(p.id, !!pixelId).catch((err: any) => {
            console.error(`[LP GENERATION] Failed to sync metaTrackingInstalled for page ${p.id}: ${err.message}`);
          }),
        ),
    );
  } catch (err: any) {
    console.error(`[LP GENERATION] Failed to sync metaTrackingInstalled across sibling pages: ${err.message}`);
  }

  // 5. Trigger Vercel re-deploy if we have a project ID
  const vercelProjectId = await resolveVercelProjectId(page);
  if (vercelProjectId) {
    try {
      await triggerVercelDeployment(vercelProjectId, `${owner}/${repo}`);
    } catch (deployErr: any) {
      console.warn(`[LP GENERATION] Could not trigger Vercel re-deploy after Meta Pixel inject: ${deployErr.message}`);
    }
  }

  return captureWarning;
}

// ---------------------------------------------------------------------------
// POST /generated/:id/meta-pixel
// Manual override for the Meta pixel/account id (API-only — no portal UI in v1).
// ---------------------------------------------------------------------------
router.post("/generated/:id/meta-pixel", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const page = auth.page;
    if (!page.githubRepoUrl) return res.status(400).json({ error: "Landing page has no GitHub repository" });

    const { pixelId, accountId } = req.body as { pixelId?: string; accountId?: string };
    if (typeof pixelId !== "string") {
      return res.status(400).json({ error: "pixelId is required" });
    }
    const trimmed = pixelId.trim();
    if (trimmed && !/^\d+$/.test(trimmed)) {
      return res.status(400).json({ error: "Invalid Meta pixel id. Expected a numeric id." });
    }

    const captureWarning = await saveMetaPixelForPage(page, trimmed, accountId);

    res.json({
      success: true,
      pixelId: trimmed,
      message: trimmed
        ? `Meta Pixel ${trimmed} injected. Your site will redeploy shortly.`
        : "Meta Pixel removed. Your site will redeploy shortly.",
      ...(captureWarning ? { warnings: [captureWarning] } : {}),
    });
  } catch (error: any) {
    console.error("[LP GENERATION] Error injecting Meta Pixel:", error);
    const httpStatus = error?.httpStatus ?? 500;
    res.status(httpStatus).json({ error: error.response?.data?.message || error.message || "Failed to inject Meta Pixel" });
  }
});

// ---------------------------------------------------------------------------
// POST|DELETE /generated/:id/session-tracking  (ENG-2327)
// Create-or-reuse the page's session list, commit the AgentWeb SDK tag into the page's own repo,
// and record sessionTrackingListId on the page. Idempotent. DELETE removes the tag and keeps the list.
// ---------------------------------------------------------------------------
function sendSessionTrackingError(res: Response, error: any, label: string) {
  if (error instanceof SessionTrackingError) {
    return res.status(error.httpStatus).json({ error: error.message, code: error.code });
  }
  const ghStatus = error?.response?.status;
  console.error(`[LP GENERATION] Error ${label} (HTTP ${ghStatus}):`, error?.response?.data?.message || error?.message);
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
    return res.status(504).json({ error: "GitHub API timed out. Try again in a moment." });
  }
  return res.status(500).json({ error: `Failed ${label}: ${error?.response?.data?.message || error?.message || "unknown error"}` });
}

router.post("/generated/:id/session-tracking", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const body = req.body ?? {};
    const { overrideExistingTracker, htmlPath } = body as { overrideExistingTracker?: unknown; htmlPath?: unknown };
    if (overrideExistingTracker !== undefined && typeof overrideExistingTracker !== "boolean") {
      return res.status(400).json({ error: "overrideExistingTracker must be a boolean" });
    }
    if (htmlPath !== undefined && typeof htmlPath !== "string") {
      return res.status(400).json({ error: "htmlPath must be a string" });
    }

    const result = await enableSessionTrackingForPage(auth.page, {
      overrideExistingTracker: overrideExistingTracker === true,
      ...(htmlPath !== undefined ? { htmlPath } : {}),
    });
    res.json({
      success: true,
      ...result,
      message: result.alreadyInstalled
        ? "Session tracking was already installed on this page."
        : "Session tracking added. Your site will redeploy shortly.",
    });
  } catch (error: any) {
    sendSessionTrackingError(res, error, "enabling session tracking");
  }
});

router.delete("/generated/:id/session-tracking", editRateLimiter, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "edit");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const htmlPath = typeof req.query.htmlPath === "string" ? req.query.htmlPath : undefined;
    const result = await disableSessionTrackingForPage(auth.page, { htmlPath });
    res.json({
      success: true,
      ...result,
      message: result.alreadyRemoved
        ? "Session tracking was not installed on this page."
        : "Session tracking removed. The session list and its history were kept.",
    });
  } catch (error: any) {
    sendSessionTrackingError(res, error, "disabling session tracking");
  }
});

// ---------------------------------------------------------------------------
// POST /site/gtm
// Injects GTM into the caller's root landing site.
// ---------------------------------------------------------------------------
router.post("/site/gtm", async (req, res: Response) => {
  const userId = (req as unknown as AuthenticatedRequest).user?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { gtmContainerId } = req.body ?? {};
    if (typeof gtmContainerId !== "string") {
      return res.status(400).json({ error: "Invalid GTM container ID" });
    }
    const isRemove = gtmContainerId.trim() === "";
    if (!isRemove && !/^GTM-[A-Z0-9]{4,10}$/.test(gtmContainerId)) {
      return res.status(400).json({ error: "Invalid GTM container ID" });
    }
    const site = await resolveSiteForCaller(userId);
    if (!site) return res.status(404).json({ error: "No landing site found" });
    await saveGtmForPage(site, isRemove ? "" : gtmContainerId);
    return res.json({ ok: true, gtmContainerId: isRemove ? "" : gtmContainerId });
  } catch (err: any) {
    console.error("POST /site/gtm failed:", err);
    const httpStatus = err?.httpStatus ?? 500;
    return res.status(httpStatus).json({ error: err?.message ?? "Failed to save GTM" });
  }
});

// ---------------------------------------------------------------------------
// GET /site/integrations
// Returns integration values for the caller's root landing site.
// ---------------------------------------------------------------------------
router.get("/site/integrations", async (req: Request, res: Response) => {
  try {
    const site = await resolveSiteForCaller((req as unknown as AuthenticatedRequest).user!.userId);
    if (!site) return res.status(404).json({ error: "No landing site found" });
    const payload = await loadIntegrationsForPage(site);
    return res.json(payload);
  } catch (err) {
    console.error("GET /site/integrations failed:", err);
    return res.status(500).json({ error: "Failed to load integrations" });
  }
});

// ---------------------------------------------------------------------------
// PUT /site/integrations
// Saves integration env vars for the caller's root landing site.
// Returns the fresh integrations payload (same shape as GET /site/integrations).
// ---------------------------------------------------------------------------
router.put("/site/integrations", async (req: Request, res: Response) => {
  try {
    const site = await resolveSiteForCaller((req as unknown as AuthenticatedRequest).user!.userId);
    if (!site) return res.status(404).json({ error: "No landing site found" });
    if (typeof req.body !== "object" || req.body == null) {
      return res.status(400).json({ error: "Invalid body" });
    }
    await saveIntegrationsForPage(site, req.body);
    const payload = await loadIntegrationsForPage(site);
    return res.json(payload);
  } catch (err) {
    console.error("PUT /site/integrations failed:", err);
    return res.status(500).json({ error: "Failed to save integrations" });
  }
});

/**
 * PATCH /api/landing-pages/v0/generated/:id/context
 * Save a plain-text context/brief describing when and how to use this landing page.
 * Body: { context: string }
 * Allowed for: page owner, org editors listed in shareSettings.landingPages.editors, org owners.
 */
router.patch("/generated/:id/context", authenticateToken, async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { context } = req.body as { context?: string };
    if (typeof context !== "string") {
      return res.status(400).json({ error: "context must be a string" });
    }
    if (context.length > 500) {
      return res.status(400).json({ error: "context must not exceed 500 characters" });
    }

    // Fetch page without user scoping to allow org-share editors
    const page = await getLandingPageById(req.params.id);
    if (!page) return res.status(404).json({ error: "Landing page not found" });

    if (page.userId !== userId) {
      const [user, pageOwner] = await Promise.all([
        userDb.getUserById(userId),
        userDb.getUserById(page.userId),
      ]);
      const ownerOrgId = pageOwner?.orgId;
      const org = (user?.orgId && user.orgId === ownerOrgId) ? await orgDb.getOrgById(user.orgId) : null;
      const allowed = canEditItem(
        { userId: page.userId },
        { userId, orgId: user?.orgId, orgRole: user?.orgRole },
        org,
        ownerOrgId,
        "landingPages"
      );
      if (!allowed) return res.status(403).json({ error: "Not authorized to edit this landing page" });
    }

    await updateLandingPageContext(req.params.id, page.userId, context.trim());
    res.json({ success: true });
  } catch (error: any) {
    console.error("[LP GENERATION] Error updating context:", error);
    res.status(500).json({ error: error.message || "Failed to update context" });
  }
});

/**
 * PATCH /api/landing-pages/v0/generated/:id/lead-list
 * Set or clear the CRM lead list associated with this landing page.
 * Body: { leadListId: string | null }
 */
router.patch("/generated/:id/lead-list", async (req, res: Response) => {
  try {
    const callerUserId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!callerUserId) return res.status(401).json({ error: "Unauthorized" });
    const { id } = req.params;
    if (!("leadListId" in (req.body ?? {}))) {
      return res.status(400).json({ error: "leadListId is required (string or null)" });
    }
    const { leadListId } = req.body as { leadListId: string | null };
    if (leadListId !== null && typeof leadListId !== "string") {
      return res.status(400).json({ error: "leadListId must be a string or null" });
    }

    const authz = await authorizeLandingPageAccess(id, callerUserId, "edit");
    if (!authz.ok) return res.status(authz.status).json({ error: authz.error });

    if (leadListId !== null) {
      const list = await crmDb.getLeadListById(leadListId);
      if (!list) return res.status(404).json({ error: "Lead list not found" });
      const sameOwner = list.userId === authz.page.userId;
      if (!sameOwner) {
        const callerUser = await userDb.getUserById(callerUserId);
        const listOwner = await userDb.getUserById(list.userId);
        const org = callerUser?.orgId ? await orgDb.getOrgById(callerUser.orgId) : null;
        const allowed = canEditItem(
          { userId: list.userId },
          { userId: callerUserId, orgId: callerUser?.orgId, orgRole: callerUser?.orgRole as any },
          org,
          listOwner?.orgId,
          "landingPages",
        );
        if (!allowed) return res.status(403).json({ error: "Lead list not accessible" });
      }
      // ENG-2323: a session (telemetry) list is never a page's lead list. After the access checks so
      // a list the caller cannot see still answers 403/404 rather than revealing its type.
      if (isSessionList(list)) return res.status(400).json({ error: SESSION_LIST_LEAD_CAPTURE_ERROR });
    }

    try {
      await updateLandingPageLeadList(id, authz.page.userId, leadListId);
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException" || err?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Page was modified concurrently" });
      }
      throw err;
    }

    // ENG-967: wiring the page to a list the platform will not accept public submissions
    // for is the same class of silent drop ENG-310 closed one step later in the chain —
    // the repo gets a correct capture route, and forward-lead 403s every lead it sends.
    // Done BEFORE the repo sync so the list is ready by the time the redeploy goes live.
    const warnings: string[] = [];
    if (leadListId !== null) {
      const publicAccessWarning = await ensureLeadListAcceptsPublicSubmissions(leadListId);
      if (publicAccessWarning) warnings.push(publicAccessWarning);
    }

    // ENG-310: the DB write alone means nothing. The capture route lives in the page's
    // GitHub repo, so the repo has to be told too — otherwise the site keeps 404ing on
    // /api/capture while the record cheerfully claims a lead list.
    const captureSyncWarning = await syncLeadCaptureForPage(authz.page, leadListId);
    if (captureSyncWarning) warnings.push(captureSyncWarning);

    const updated = await getLandingPageById(id);
    if (!warnings.length) return res.json(updated);
    // `captureSyncWarning` is the field the portal's lead-list picker already reads and shows
    // verbatim (PageLeadListPicker.tsx), so it keeps carrying every warning — each entry is a
    // complete sentence, so joining stays readable. `warnings` is added alongside it so a
    // caller can tell the two failures apart instead of parsing one blob; nothing depends on
    // it yet, and dropping the joined field would silently mute the toast.
    return res.json({ ...updated, captureSyncWarning: warnings.join(" "), warnings });
  } catch (err) {
    console.error("PATCH /lead-list failed:", err);
    return res.status(500).json({ error: "Failed to update lead list" });
  }
});

/**
 * Push the site's lead-capture files to its GitHub repo after a lead list was attached
 * to / detached from one of its pages (ENG-310).
 *
 * The capture route is REPO-level but the lead list is PER-PAGE, so the repo needs the
 * map for the WHOLE SITE, not just the page that changed — writing only this page's entry
 * would blank out every sibling page's list and misfile (or drop) their leads.
 *
 * Never throws: by the time this runs the DynamoDB write has already happened. A GitHub
 * failure must not 500 the request and leave the user thinking nothing was saved — it
 * returns a warning string instead, so the caller can say "wired, but the site hasn't
 * picked it up yet".
 *
 * @returns a warning message if the repo was NOT updated, else undefined.
 */
async function syncLeadCaptureForPage(
  page: GeneratedLandingPage,
  leadListId: string | null
): Promise<string | undefined> {
  // Not deployed yet → there is no repo to sync. Generation injects the capture files
  // itself, with this list already attached, so there is nothing to warn about.
  if (!page.githubRepoUrl) return undefined;

  const repoMatch = page.githubRepoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\s|$)/);
  if (!repoMatch) {
    console.error(`[LP GENERATION] ENG-310: unparseable githubRepoUrl on page ${page.id}: ${page.githubRepoUrl}`);
    // Same "saved" wrongness the captureRouteSkipped arm below was fixed for: a detach that
    // reports "saved" tells the owner the opposite of what they asked for.
    return `${leadListId === null ? "Lead list removed" : "Lead list saved"}, but this page's ` +
      `GitHub repo URL is malformed so the live site was not updated.`;
  }
  const repoFullName = repoMatch[1];

  try {
    // ENG-485: re-derived FRESH by syncLeadCaptureFilesToRepo on every retry attempt, not
    // just once here — see that function's own doc comment on why a static snapshot isn't
    // safe to reuse across a rebase retry.
    const buildListByPath = async (): Promise<Record<string, string>> => {
      // Every page of this site — i.e. every page deployed into this same repo. Sibling
      // pages are the page owner's (UserIdIndex query, same pattern routes/domains.ts uses).
      const siblings = await getLandingPagesByOwner(page.userId);
      const listByPath: Record<string, string> = {};
      for (const p of siblings) {
        if (p.id === page.id) continue; // this page's entry comes from the write below
        if (p.githubRepoUrl !== page.githubRepoUrl) continue; // different site, different repo
        if (!p.leadListId) continue;
        // Same path convention routes/domains.ts uses for its domain map.
        listByPath[p.slug ? `/${p.slug}` : "/"] = p.leadListId;
      }
      // The page we just wrote, from the value we wrote — the GSI read above is eventually
      // consistent and may still be showing the old value. A detach (null) simply leaves the
      // page OUT of the map, so its form starts failing loudly (422) rather than quietly
      // filing leads into a list it is no longer wired to.
      if (leadListId) {
        listByPath[page.slug ? `/${page.slug}` : "/"] = leadListId;
      }
      return listByPath;
    };

    // ENG-489: syncLeadCaptureFilesToRepo fully regenerates app/api/capture/route.ts,
    // so omitting the site's pixelId/metaAdAccountId here would silently strip an
    // already-configured Meta pixel back out of the route on every lead-list attach.
    // metaPixelId/metaAdAccountId live on the SITE ROOT record, which may not be `page`
    // itself (a lead list can be attached to any sub-page) — resolve it once (not part of
    // the race being fixed above — site-level config, not the fast-changing sibling list).
    // The root's own id equals the site's siteId by construction — more reliable than
    // the isRootPage flag, which isn't guaranteed set on every record.
    const siteId = page.siteId ?? page.id;
    const rootRecord = page.id === siteId
      ? page
      : (await getLandingPagesByOwner(page.userId)).find((p) => p.id === siteId);

    const result = await syncLeadCaptureFilesToRepo(
      repoFullName,
      buildListByPath,
      rootRecord?.metaPixelId,
      rootRecord?.metaAdAccountId,
    );
    // captureRouteSkipped first: its contract states that NEITHER `committed` nor
    // `up-to-date` implies the route carries this page's path — when the deployed
    // LIST_BY_PATH could not be parsed, route.ts is left out of the commit entirely.
    // Returning "saved" over that reports success for a list attachment whose leads will
    // still 422, which is the one outcome the flag exists to prevent.
    if (result.captureRouteSkipped) {
      // Attaching and DETACHING both come through here, and the consequence is opposite for
      // each. captureRouteSkipped means route.ts was left EXACTLY as deployed, so it still
      // carries the old mapping: an attach's leads are not filed yet, while a detach's leads
      // keep being filed into the list the user just removed. Saying "will not be filed" on
      // a detach tells the user the opposite of what happens.
      const untouched =
        `capture route could not be updated — its deployed route file could not be parsed, ` +
        `so it was left untouched.`;
      if (leadListId === null) {
        return (
          `Lead list removed, but this site's ${untouched} Submissions from this page will ` +
          `KEEP being filed into the list you just removed until the route is repaired.`
        );
      }
      // Re-submitting the SAME list is not a change at all: the untouched deployed route
      // already maps this path to exactly the list that was asked for, so there is nothing
      // to warn about. Reachable from an idempotent PATCH retry or re-picking the current
      // list. Warning here would claim leads are not being filed while they are.
      if (page.leadListId === leadListId) return undefined;
      // A SWITCH is not a first attach. The deployed route still carries the old mapping, so
      // submissions keep arriving — into the PREVIOUS list, silently. "Will not be filed"
      // would be wrong in the same direction the detach arm above was wrong.
      if (page.leadListId) {
        return (
          `The lead list was saved, but this site's ${untouched} Submissions from this page ` +
          `will KEEP being filed into the previously attached list until the route is repaired.`
        );
      }
      return (
        `The lead list was saved, but this site's ${untouched} Submissions from this page ` +
        `will not be filed until the route is repaired.`
      );
    }
    if (result.committed || result.reason === "up-to-date") return undefined;
    // Attaching and DETACHING both come through here; "saved" is wrong for a removal.
    const lead = leadListId === null ? "Lead list removed" : "Lead list saved";
    // Not transient: no retry or redeploy installs a capture layer we refuse to install, so
    // this must not borrow the "applied on the next deploy" wording below.
    if (result.reason === NO_CAPTURE_LAYER) {
      return (
        `${lead}, but this page's site does not use the platform's lead-capture code, ` +
        "so its form was not changed. Wire the form up in the site's own repository."
      );
    }
    return `${lead}, but the live site was not updated (${result.reason}). It will be applied on the next deploy or retry.`;
  } catch (err: any) {
    // syncLeadCaptureFilesToRepo does not throw, so this is a sibling-fetch failure.
    console.error(`[LP GENERATION] ENG-310: lead-capture sync failed for page ${page.id}:`, err?.message || err);
    return `${leadListId === null ? "Lead list removed" : "Lead list saved"}, but the live site ` +
      `was not updated. It will be applied on the next deploy or retry.`;
  }
}

export default router;
