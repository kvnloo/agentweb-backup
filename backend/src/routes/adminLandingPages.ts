/**
 * ENG-721: admin discovery/reassociation of landing pages by URL or org.
 *
 * Mounted at /api/admin/landing-pages behind authenticateToken + isAdmin
 * (see app.ts) — every route here is admin-only. Gives Emma's admin tools a
 * governed path for what previously required raw DynamoDB:
 *
 *   GET  /resolve?url=…            resolve a page (any owner) by URL/domain
 *   POST /:id/org-share            enable owner-org sharing + grant editors
 *   GET  /:id/effective-view?member=…  a member's effective access to a page
 *
 * Cross-account mutations are audited via recordAdminAudit (ENG-721 AC4).
 */
import express, { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import {
  adminFindLandingPagesByUrl,
  getLandingPageById,
  getLandingPageLiveUrl,
  GeneratedLandingPage,
} from "../services/v0Service";
import { userDb, orgDb } from "../services/db";
import {
  canViewItem,
  canEditItem,
  defaultShareSettings,
} from "../services/orgShareService";
import { recordAdminAudit } from "../services/adminAuditLog";

const router = express.Router();

interface UserRecordLike {
  userId: string;
  email?: string;
  orgId?: string;
  orgRole?: "owner" | "admin" | "member";
}

function pageSummary(page: GeneratedLandingPage) {
  return {
    id: page.id,
    userId: page.userId,
    name: page.name,
    status: page.status,
    deployedUrl: page.deployedUrl ?? null,
    customDomainUrl: page.customDomainUrl ?? null,
    leadListId: page.leadListId ?? null,
    slug: (page as any).slug ?? null,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

/** Resolve a member reference (email or userId) to a user record. */
async function resolveMember(ref: string): Promise<UserRecordLike | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    return ((await userDb.getUserByEmail(trimmed.toLowerCase())) as UserRecordLike | null) ?? null;
  }
  return ((await userDb.getUserById(trimmed)) as UserRecordLike | null) ?? null;
}

async function memberAccess(
  page: GeneratedLandingPage,
  member: UserRecordLike,
  ownerOrgId: string | undefined,
  orgOverride?: import("../services/orgShareService").OrgLike | null
) {
  const org =
    member.orgId && member.orgId === ownerOrgId
      ? orgOverride ?? (await orgDb.getOrgById(member.orgId))
      : null;
  const userLike = { userId: member.userId, orgId: member.orgId, orgRole: member.orgRole };
  const itemLike = { userId: page.userId };
  return {
    canView: canViewItem(itemLike, userLike, org, ownerOrgId, "landingPages"),
    canEdit: canEditItem(itemLike, userLike, org, ownerOrgId, "landingPages"),
  };
}

/**
 * GET /resolve?url=<url or bare host>
 * Cross-account lookup by URL/domain. 404 (with empty matches) when nothing
 * matched; `scannedAll: false` flags an inconclusive capped scan.
 */
router.get("/resolve", async (req: Request, res: Response) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim() : "";
  if (!url) return res.status(400).json({ message: "Query param 'url' is required" });
  let hostCheck: URL;
  try {
    hostCheck = new URL(url.includes("://") ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ message: "Query param 'url' is not a valid URL or hostname" });
  }
  if (!hostCheck.hostname.includes(".")) {
    return res.status(400).json({ message: "Query param 'url' is not a valid URL or hostname" });
  }

  try {
    const { matches, scannedAll } = await adminFindLandingPagesByUrl(url);
    const enriched = await Promise.all(
      matches.map(async (page) => {
        const owner = (await userDb.getUserById(page.userId)) as UserRecordLike | null;
        return {
          page: pageSummary(page),
          owner: owner
            ? { userId: owner.userId, email: owner.email ?? null, orgId: owner.orgId ?? null }
            : { userId: page.userId, email: null, orgId: null },
          liveUrl: getLandingPageLiveUrl(page),
        };
      })
    );
    const status = enriched.length > 0 ? 200 : 404;
    return res.status(status).json({ matches: enriched, scannedAll });
  } catch (error: any) {
    console.error("adminLandingPages resolve error:", error?.message ?? error);
    return res.status(500).json({ message: "Failed to resolve landing page by URL" });
  }
});

/**
 * POST /:id/org-share
 * Body: { memberEmails?: string[], memberUserIds?: string[], enable?: boolean }
 * Enables the owner org's landingPages sharing (unless enable === false is
 * passed explicitly) and adds the named members to the editor list. No page
 * duplication, no redeploy — visibility/edit is entirely shareSettings.
 */
router.post("/:id/org-share", async (req: Request, res: Response) => {
  const { id } = req.params;
  const memberRefs: string[] = [
    ...(Array.isArray(req.body?.memberEmails) ? req.body.memberEmails : []),
    ...(Array.isArray(req.body?.memberUserIds) ? req.body.memberUserIds : []),
  ].filter((r): r is string => typeof r === "string" && r.trim().length > 0);
  if (memberRefs.length === 0) {
    return res.status(400).json({ message: "At least one memberEmails or memberUserIds entry is required" });
  }
  const enable = req.body?.enable !== false;

  try {
    const page = await getLandingPageById(id);
    if (!page) return res.status(404).json({ message: "Landing page not found" });

    const owner = (await userDb.getUserById(page.userId)) as UserRecordLike | null;
    const ownerOrgId = owner?.orgId;
    if (!ownerOrgId) {
      return res.status(400).json({
        message: "Page owner does not belong to an organization — org-level sharing is not applicable",
      });
    }
    const org = await orgDb.getOrgById(ownerOrgId);
    if (!org) return res.status(404).json({ message: "Owner organization not found" });

    const orgMembers = (await orgDb.getOrgMembers(ownerOrgId)) as UserRecordLike[];
    const memberById = new Map(orgMembers.map((m) => [m.userId, m]));

    const resolved: UserRecordLike[] = [];
    for (const ref of memberRefs) {
      const user = await resolveMember(ref);
      if (!user || !memberById.has(user.userId)) {
        return res.status(400).json({
          message: `'${ref}' is not a member of the page owner's organization`,
        });
      }
      resolved.push(user);
    }

    // Read-modify-write guarded on updatedAt: an overlapping sharing request
    // (or departed-member cleanup) fails the conditional write, and we re-read
    // and re-apply this grant on top of the fresh document instead of
    // clobbering it (last-writer-wins loses the other writer's changes).
    const MAX_SHARE_WRITE_ATTEMPTS = 5;
    let settings: any;
    let lp: { enabled: boolean; editors: string[] };
    let before: Set<string>;
    let granted: string[];
    let currentOrg = org;
    for (let attempt = 0; ; attempt++) {
      settings = currentOrg.shareSettings
        ? JSON.parse(JSON.stringify(currentOrg.shareSettings))
        : defaultShareSettings();
      lp = settings.landingPages ?? { enabled: false, editors: [] };
      lp.enabled = enable;
      before = new Set<string>(lp.editors ?? []);
      granted = resolved
        .map((m) => m.userId)
        // Org owner already has full authority; listing them is redundant noise.
        .filter((uid) => uid !== currentOrg.ownerUserId);
      lp.editors = [...new Set([...(lp.editors ?? []), ...granted])];
      settings.landingPages = lp;

      try {
        await orgDb.updateShareSettings(ownerOrgId, settings, currentOrg.updatedAt);
        break;
      } catch (writeError: any) {
        if (writeError?.code !== "ConditionalCheckFailedException" || attempt >= MAX_SHARE_WRITE_ATTEMPTS - 1) {
          throw writeError;
        }
        const reread = await orgDb.getOrgById(ownerOrgId);
        if (!reread) return res.status(404).json({ message: "Owner organization not found" });
        // The conflicting writer may have removed a member we validated
        // before the first attempt (departed-member cleanup). Re-applying the
        // grant from the stale resolved list would silently restore their
        // editor entry, so revalidate membership against the fresh org.
        const freshMembers = (await orgDb.getOrgMembers(ownerOrgId)) as UserRecordLike[];
        const freshMemberIds = new Set(freshMembers.map((m) => m.userId));
        const departed = resolved.filter((m) => !freshMemberIds.has(m.userId));
        if (departed.length > 0) {
          return res.status(409).json({
            message: `Organization membership changed concurrently — no longer members: ${departed
              .map((m) => m.email ?? m.userId)
              .join(", ")}`,
          });
        }
        currentOrg = reread;
      }
    }

    const actor = (req as AuthenticatedRequest).user;
    recordAdminAudit({
      actorUserId: actor!.userId,
      actorEmail: actor!.email,
      action: "landing_page_org_share",
      pageId: page.id,
      pageOwnerUserId: page.userId,
      orgId: ownerOrgId,
      enabled: lp.enabled,
      grantedEditorUserIds: granted,
      newlyGrantedEditorUserIds: granted.filter((uid) => !before.has(uid)),
    });

    const members = await Promise.all(
      resolved.map(async (m) => ({
        userId: m.userId,
        email: m.email ?? null,
        // Compute against the settings just written, not a re-read (avoids
        // returning a stale pre-mutation view under eventual consistency).
        ...(await memberAccess(page, m, ownerOrgId, { ...currentOrg, shareSettings: settings })),
      }))
    );

    return res.status(200).json({
      page: pageSummary(page),
      orgId: ownerOrgId,
      landingPagesShare: { enabled: lp.enabled, editors: lp.editors },
      members,
    });
  } catch (error: any) {
    console.error("adminLandingPages org-share error:", error?.message ?? error);
    return res.status(500).json({ message: "Failed to update org share settings" });
  }
});

/**
 * GET /:id/effective-view?member=<email or userId>
 * What the named user actually sees for this page: view/edit authority,
 * canonical live URL, deploy status, connected lead list.
 */
router.get("/:id/effective-view", async (req: Request, res: Response) => {
  const { id } = req.params;
  const memberRef = typeof req.query.member === "string" ? req.query.member : "";
  if (!memberRef.trim()) {
    return res.status(400).json({ message: "Query param 'member' (email or userId) is required" });
  }
  try {
    const page = await getLandingPageById(id);
    if (!page) return res.status(404).json({ message: "Landing page not found" });
    const member = await resolveMember(memberRef);
    if (!member) return res.status(404).json({ message: "Member not found" });

    const owner = (await userDb.getUserById(page.userId)) as UserRecordLike | null;
    const access = await memberAccess(page, member, owner?.orgId);

    return res.status(200).json({
      member: { userId: member.userId, email: member.email ?? null, orgId: member.orgId ?? null },
      ...access,
      liveUrl: getLandingPageLiveUrl(page),
      status: page.status,
      leadListId: page.leadListId ?? null,
      page: pageSummary(page),
    });
  } catch (error: any) {
    console.error("adminLandingPages effective-view error:", error?.message ?? error);
    return res.status(500).json({ message: "Failed to compute effective view" });
  }
});

export default router;
