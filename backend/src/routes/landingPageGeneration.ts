import { Router, Request, Response, NextFunction } from "express";
import { emitLanderLifecycle, landerChannelFromRequest } from "../services/landerLifecycleEvents";
import axios from "axios";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { settingsService } from "../services/settingsService";
import { userDb, orgDb, crmDb } from "../services/db";
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
  recordLandingPagePublish,
  markLandingPagePublishReverted,
  INTEGRATIONS,
  resolveSiteForCaller,
  getLandingPageLiveUrl,
  canUserEditLandingPage,
} from "../services/v0Service";
import { canEditItem, canViewItem, canManageOrgFeature, isFeatureEffectivelyEnabled } from "../services/orgShareService";
import { listDomains, CustomDomainRecord, SUBDOMAIN_BASE } from "../services/customDomainService";

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

// Branch name must be draft/<id> where id is alphanumeric, dashes, underscores (8-64 chars)
const VALID_BRANCH_RE = /^draft\/[a-zA-Z0-9_-]{8,64}$/;

function validateBranchName(branch: string): boolean {
  return branch === "main" || VALID_BRANCH_RE.test(branch);
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
      deployStatus,
    });
  } catch (err) {
    console.error("GET /site failed:", err);
    return res.status(500).json({ error: "Failed to load site" });
  }
});

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
    const caller = await userDb.getUserById(userId);
    if (caller?.orgId) {
      const org = await orgDb.getOrgById(caller.orgId);
      const allowed = canManageOrgFeature(
        { userId, orgId: caller.orgId, orgRole: caller.orgRole as "owner" | "member" | undefined },
        org,
        "landingPages",
      );
      if (!allowed) {
        return res.status(403).json({ error: "Landing pages are managed by your org admin" });
      }
    }

    const { prompt, name, lead_list_id, template_html: rawTemplateHtml, template_id, site_id, originating_session_id } = req.body;
    // Condense uploaded HTML to avoid exceeding v0 prompt size limits
    let template_html: string | undefined = rawTemplateHtml
      ? extractTemplateOutline(rawTemplateHtml)
      : undefined;

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

    const pageName = name || prompt.slice(0, 60);

    // Fetch brand guidelines + market strategy for maximum context
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bg = user.brandGuidelines;
        const bd = (bg as any).brandData || {};
        brandContext = {
          brandName: bd.brandName,
          primaryColor: bd.primaryColor,
          primaryColorEnd: bd.primaryColorEnd,
          isGradient: bd.isGradient,
          secondaryColor: bd.secondaryColor,
          fontFamily: bd.fontFamily,
          tagline: bd.tagline,
          toneOfVoice: bd.toneOfVoice,
          brandPersonality: bd.brandPersonality,
          keyMessages: bd.keyMessages,
          brandValues: bd.brandValues,
          targetAudience: bd.targetAudience,
          founders: bd.founders,
        };

        // Get logo URL from attachments
        if ((bg as any).attachments && Array.isArray((bg as any).attachments)) {
          const logo = (bg as any).attachments.find(
            (a: any) => a.type === "logo" && a.url
          );
          if (logo) {
            brandContext.logoUrl = logo.url;
          }
        }
      }

      // Pull market strategy for richer landing page copy
      if (user?.marketStrategy) {
        const ms = user.marketStrategy;
        brandContext.businessOverview = ms.businessOverview;
        brandContext.icp = ms.icp;
        brandContext.competitors = ms.competitors;
      }
    } catch (error) {
      console.error("[LP GENERATION] Failed to fetch brand guidelines, continuing without:", error);
    }

    // Auto-enable public access on the lead list so the landing page form works
    if (lead_list_id) {
      try {
        const list = await crmDb.getLeadListById(lead_list_id);
        if (list && !list.publicAccessEnabled) {
          await crmDb.updateLeadList(lead_list_id, { publicAccessEnabled: true });
          console.log(`[LP GENERATION] Auto-enabled public access on lead list ${lead_list_id}`);
        }
      } catch (err) {
        console.warn(`[LP GENERATION] Could not auto-enable public access on lead list:`, err);
      }
    }

    const result = await generateLandingPage(userId, prompt, pageName, brandContext, lead_list_id, template_html, {
      siteId: typeof site_id === "string" ? site_id : undefined,
      originatingSessionId: typeof originating_session_id === "string" ? originating_session_id : undefined,
    });
    void emitLanderLifecycle("created", { pageId: (result as any)?.id || "unknown", userId, channel: landerChannelFromRequest(req), mode: "cold_start", outcome: (result as any)?.status === "failed" ? "failed" : "ok" });
    res.status(201).json(result);
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
    const status = error.message?.includes("not found") ? 404 : 500;
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

    const result = await iterateLandingPage(auth.page.id, auth.page.userId, message);
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
      const rank = (d: CustomDomainRecord) => (d.type === "custom" ? 1 : 0);
      for (const [ownerId, domains] of domainsByOwner) {
        for (const d of domains) {
          if (!d.vercelProjectId) continue;
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
      ...p,
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

    await deleteLandingPageByRecord(page);
    res.json({ success: true });
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
router.post("/generated/:id/duplicate", async (req, res: Response) => {
  try {
    const userId = (req as unknown as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const auth = await authorizeLandingPageAccess(req.params.id, userId, "view");
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
    const original = auth.page;

    const { name } = req.body;
    const newName = name || `${original.name} (copy)`;

    // Re-generate using the original prompt + full brand context
    let brandContext: BrandContext = {};
    try {
      const user = await userDb.getUserById(userId);
      if (user?.brandGuidelines) {
        const bg = user.brandGuidelines;
        const bd = (bg as any).brandData || {};
        brandContext = {
          brandName: bd.brandName,
          primaryColor: bd.primaryColor,
          primaryColorEnd: bd.primaryColorEnd,
          isGradient: bd.isGradient,
          secondaryColor: bd.secondaryColor,
          fontFamily: bd.fontFamily,
          tagline: bd.tagline,
          toneOfVoice: bd.toneOfVoice,
          brandPersonality: bd.brandPersonality,
          keyMessages: bd.keyMessages,
          brandValues: bd.brandValues,
          targetAudience: bd.targetAudience,
          founders: bd.founders,
        };
        if ((bg as any).attachments && Array.isArray((bg as any).attachments)) {
          const logo = (bg as any).attachments.find((a: any) => a.type === "logo" && a.url);
          if (logo) brandContext.logoUrl = logo.url;
        }
      }
      if (user?.marketStrategy) {
        brandContext.businessOverview = user.marketStrategy.businessOverview;
        brandContext.icp = user.marketStrategy.icp;
        brandContext.competitors = user.marketStrategy.competitors;
      }
    } catch {}

    const result = await generateLandingPage(userId, original.prompt, newName, brandContext);
    res.status(201).json(result);
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

    if (!file_path || !content) {
      return res.status(400).json({ error: "file_path and content are required" });
    }

    if (!validateBranchName(branch)) {
      return res.status(400).json({ error: "Invalid branch name. Must be 'main' or 'draft/<id>'." });
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
    const liveUrl = getLandingPageLiveUrl(page);
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
    try {
      const mergeRes = await axios.post<any>(
        `${repoBase}/merges`,
        {
          base: "main",
          head: branch,
          commit_message: `Publish landing page changes from ${branch}`,
        },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      mergeCommitSha = mergeRes.data.sha;
      console.log(`[LP GENERATION] Merged ${branch} into main: ${mergeCommitSha?.substring(0, 7)}`);
    } catch (mergeErr: any) {
      if (mergeErr.response?.status !== 409) throw mergeErr;

      console.warn(`[LP GENERATION] Standard merge returned 409; force-advancing main to draft branch tip`);

      // Get the current SHA of the draft branch tip
      const branchRes = await axios.get<any>(
        `${repoBase}/git/ref/heads/${encodeURIComponent(branch)}`,
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      const draftSha: string = branchRes.data.object.sha;

      // Force-update main to point at the draft branch tip
      await axios.patch<any>(
        `${repoBase}/git/refs/heads/main`,
        { sha: draftSha, force: true },
        { headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS }
      );
      mergeCommitSha = draftSha;
      console.log(`[LP GENERATION] Force-advanced main to draft tip ${draftSha.substring(0, 7)}`);
    }

    // Delete the draft branch
    try {
      await axios.delete(`${repoBase}/git/refs/heads/${branch}`, {
        headers: ghHeaders, timeout: GITHUB_TIMEOUT_MS,
      });
      console.log(`[LP GENERATION] Deleted branch ${branch}`);
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

    const liveUrl = getLandingPageLiveUrl(page);
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

    const result = await getPreviewDeploymentUrl(vercelProjectId, branch);
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

      // 2. Build GTM snippets
      const gtmHeadSnippet =
        `        {/* Google Tag Manager */}\n` +
        `        <script dangerouslySetInnerHTML={{ __html: \`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${containerId}');\` }} />\n` +
        `        {/* End Google Tag Manager */}`;

      const gtmBodySnippet =
        `        {/* Google Tag Manager (noscript) */}\n` +
        `        <noscript dangerouslySetInnerHTML={{ __html: \`<iframe src="https://www.googletagmanager.com/ns.html?id=${containerId}" height="0" width="0" style="display:none;visibility:hidden"></iframe>\` }} />\n` +
        `        {/* End Google Tag Manager (noscript) */}`;

      // 3. Strip any existing GTM blocks (always, whether adding or removing)
      let updatedContent = currentContent
        .replace(/[ \t]*\{\/\* Google Tag Manager \*\/\}[\s\S]*?\{\/\* End Google Tag Manager \*\/\}\n?/g, "")
        .replace(/[ \t]*\{\/\* Google Tag Manager \(noscript\) \*\/\}[\s\S]*?\{\/\* End Google Tag Manager \(noscript\) \*\/\}\n?/g, "");

      // Only re-inject if we have a non-empty containerId
      if (containerId) {
        // Insert head snippet inside <head> (before </head> or before first child after <head>)
        if (/<head[^>]*>/.test(updatedContent)) {
          updatedContent = updatedContent.replace(
            /(<head[^>]*>)/,
            `$1\n${gtmHeadSnippet}`
          );
        } else {
          // Fallback: insert before <body
          updatedContent = updatedContent.replace(
            /(<body[^>]*>)/,
            `${gtmHeadSnippet}\n      $1`
          );
        }

        // Insert noscript snippet immediately after <body ...>
        if (/<body[^>]*>/.test(updatedContent)) {
          updatedContent = updatedContent.replace(
            /(<body[^>]*>)/,
            `$1\n${gtmBodySnippet}`
          );
        }
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
    }

    try {
      await updateLandingPageLeadList(id, authz.page.userId, leadListId);
    } catch (err: any) {
      if (err?.code === "ConditionalCheckFailedException" || err?.name === "ConditionalCheckFailedException") {
        return res.status(409).json({ error: "Page was modified concurrently" });
      }
      throw err;
    }
    const updated = await getLandingPageById(id);
    return res.json(updated);
  } catch (err) {
    console.error("PATCH /lead-list failed:", err);
    return res.status(500).json({ error: "Failed to update lead list" });
  }
});

export default router;
