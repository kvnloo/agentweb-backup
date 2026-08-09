import { Router, Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb, orgDb, Organization } from "../services/db";
import { defaultShareSettings } from "../services/orgShareService";
import { callerCan, can, roleOf } from "../services/orgAuthz";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { isCompanyEmail } from "../utils/validation";

const router = Router();

type MarketStrategy = NonNullable<Organization["marketStrategy"]>;
type MarketIcp = MarketStrategy["icp"][number];
type MarketCompetitor = MarketStrategy["competitors"][number];

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function mapOnboardingIcps(user: any): MarketIcp[] {
  if (!Array.isArray(user.icpResult)) return [];
  return user.icpResult
    .map((icp: any) => ({
      title: typeof icp?.name === "string" ? icp.name : "",
      description: typeof icp?.pain === "string" ? icp.pain : "",
      valueProposition: typeof icp?.desire === "string" ? icp.desire : "",
      buyerPersonas:
        typeof icp?.meta_targeting_brief === "string" && icp.meta_targeting_brief
          ? [icp.meta_targeting_brief]
          : [],
    }))
    .filter((icp: MarketIcp) => icp.title || icp.description || icp.valueProposition || icp.buyerPersonas.length > 0);
}

function mapOnboardingCompetitors(user: any): MarketCompetitor[] {
  const perIcp = user.competitorResult?.per_icp;
  if (!Array.isArray(perIcp)) return [];

  const grouped = new Map<string, string[]>();
  for (const entry of perIcp) {
    const names = Array.isArray(entry?.competitor_names) ? entry.competitor_names : [];
    const angles = Array.isArray(entry?.offer_angles) ? entry.offer_angles : [];
    for (const rawName of names) {
      const name = typeof rawName === "string" ? rawName.trim() : "";
      if (!name) continue;
      if (!grouped.has(name)) grouped.set(name, []);
      const bucket = grouped.get(name)!;
      for (const rawAngle of angles) {
        const angle = typeof rawAngle === "string" ? rawAngle.trim() : "";
        if (angle && !bucket.includes(angle)) bucket.push(angle);
      }
    }
  }

  return Array.from(grouped.entries()).map(([name, angles]) => ({
    name,
    description: angles.slice(0, 2).join("; ") || "Identified during onboarding",
  }));
}

function buildOrgMarketStrategyForCopy(user: any): MarketStrategy | undefined {
  const existing = user.marketStrategy as MarketStrategy | undefined;
  const fallbackIcps = mapOnboardingIcps(user);
  const fallbackCompetitors = mapOnboardingCompetitors(user);
  const shouldFillIcps = !hasItems(existing?.icp) && fallbackIcps.length > 0;
  const shouldFillCompetitors = !hasItems(existing?.competitors) && fallbackCompetitors.length > 0;

  if (!existing && !shouldFillIcps && !shouldFillCompetitors) return undefined;
  if (existing && !shouldFillIcps && !shouldFillCompetitors) return existing;

  const now = new Date().toISOString();
  return {
    businessOverview: existing?.businessOverview ?? "",
    competitors: shouldFillCompetitors ? fallbackCompetitors : (existing?.competitors ?? []),
    icp: shouldFillIcps ? fallbackIcps : (existing?.icp ?? []),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

// All org routes require authentication
router.use(authenticateToken);

// Read and write authority over org connected accounts are separate questions, so
// they get separate predicates rather than one shared `isOrgOwner`. They resolve
// the same way today (both owner+admin) but splitting them is what makes a
// read-only oversight role expressible later without decomposing either route.
function canSeeAllOrgAccounts(user: any, org: Organization): boolean {
  return can({ userId: user.userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:accounts:read");
}

function canManageOrgAccounts(user: any, org: Organization): boolean {
  return can({ userId: user.userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:accounts:manage");
}

/**
 * The last-one-out invariant: an org must always retain at least one owner.
 *
 * Enforced on every verb that can take an owner away — remove, leave, and
 * demote. Better Auth shipped the first two and not the third, and a demote
 * orphaned an org (better-auth#3651); the demote path is the one that gets
 * missed, so it is guarded here explicitly.
 *
 * Counted from the live GSI-backed member list rather than a denormalized
 * counter. Org membership is capped by nothing now, but orgs are small and this
 * runs only on the three membership-mutating verbs, so a Query is the right
 * trade against maintaining another counter — that is exactly the apparatus the
 * seat cap left behind.
 *
 * `losingUserId` is the member about to stop being an owner. Returns true when
 * at least one OTHER owner would remain.
 */
async function anotherOwnerRemains(org: Organization, losingUserId: string): Promise<boolean> {
  const members = await orgDb.getOrgMembers(org.orgId);
  return members.some(
    (m) => m.userId !== losingUserId && roleOf({ userId: m.userId, orgId: m.orgId, orgRole: m.orgRole }, org) === "owner"
  );
}

/**
 * Move the billing root off a departing member.
 *
 * `Organization.ownerUserId` is written in exactly one place — org creation —
 * and nothing has ever moved it. That was survivable only because the primary
 * owner could not leave: the old leave route blocked on
 * `ownerUserId === userId` and pointed at a transfer route nobody built.
 *
 * ENG-954 removed that block, which is correct — an owner must be able to
 * leave — but the block was standing in for this. Without it, promote-then-
 * leave (the succession path this design commits to, and the one the demote
 * error tells people to use) leaves `ownerUserId` pointing at an ex-member.
 * The org stays administrable, because the remaining owners hold authority by
 * role; but billing does not. `resolveBillingUserId` follows the pointer, so
 * the org's tier and pooled quota resolve to someone who has left, and follow
 * THEIR subscription from then on.
 *
 * So departure carries the pointer with it. That IS the transfer, performed at
 * the only moment it is unambiguous. Callers must have already established
 * that another owner remains — every caller here is behind that guard, and
 * this returns false rather than guessing if that is somehow untrue.
 */
export async function reassignBillingRootOnDeparture(
  org: Organization,
  departingUserId: string,
  /**
   * The owner performing the removal. They take billing, which is the rule
   * Harsha asked for and the least surprising one: the person who decided the
   * billing owner should go is the person who inherits it, and they find out
   * by seeing the badge land on their own row. Absent on `leave`, where nobody
   * is acting on anyone — that falls back to a deterministic pick.
   */
  actingUserId?: string,
): Promise<boolean> {
  if (org.ownerUserId !== departingUserId) return true; // not the billing root
  const members = await orgDb.getOrgMembers(org.orgId);
  const owners = members.filter((m) => m.userId !== departingUserId && m.orgRole === "owner");
  const successor =
    owners.find((m) => m.userId === actingUserId) ??
    // Deterministic, so a retry picks the same successor as the first attempt.
    owners.sort((a, b) => a.userId.localeCompare(b.userId))[0];
  if (!successor) return false;
  await orgDb.updateOrg(org.orgId, { ownerUserId: successor.userId });
  console.log(
    `[org] billing root moved ${departingUserId} -> ${successor.userId} on departure from ${org.orgId}`,
  );
  return true;
}

// Domain always derived server-side from the acting user's own email — never
// client-supplied — so nobody can claim a domain they don't belong to.
function deriveDomainFromEmail(email: string): string | undefined {
  return email.split("@")[1]?.toLowerCase() || undefined;
}

function sanitizeConnectedAccountForOrgResponse(account: any): any {
  const safeConfig: Record<string, any> = {};
  for (const [key, value] of Object.entries(account.config || {})) {
    const normalizedKey = key.toLowerCase();
    const looksCredentialLike =
      normalizedKey === "token" ||
      normalizedKey.endsWith("_token") ||
      normalizedKey.endsWith("token") ||
      normalizedKey.includes("secret") ||
      normalizedKey === "api_key" ||
      normalizedKey === "apikey";
    if (!looksCredentialLike) {
      safeConfig[key] = value;
    }
  }

  return {
    ...account,
    config: safeConfig,
  };
}

// Create organization
router.post("/", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // User must not already be in an org
    if (user.orgId) {
      return res.status(400).json({ error: "You are already in an organization. Leave your current org first." });
    }

    const { name } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Organization name is required" });
    }

    const now = new Date().toISOString();
    const org: Organization = {
      orgId: uuidv4(),
      name: name.trim(),
      ownerUserId: userId,
      // The owner is the org's first member. Seeded directly (no transaction
      // needed — this org doesn't exist in the table until this exact call,
      // so there's no concurrent joiner to race against).
      pendingInvites: [],
      // Seed sharing defaults at creation so the toggle UI and member-fanout
      // gating agree from day one (skills + work plans shared org-wide by
      // default). Without this, new orgs had no shareSettings and default-on
      // features silently fell through to "off" for plain members.
      shareSettings: defaultShareSettings(),
      createdAt: now,
      updatedAt: now,
    };

    await orgDb.createOrg(org);

    // Update user with orgId and owner role
    await userDb.updateUser(userId, { orgId: org.orgId, orgRole: "owner" });

    return res.status(201).json({ success: true, data: org });
  } catch (error) {
    console.error("Error creating organization:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get current user's organization
router.get("/me", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const user = await userDb.getUserById(userId);
    if (!user || !user.orgId) {
      return res.json({ success: true, data: null });
    }

    const org = await orgDb.getOrgById(user.orgId);
    if (!org) {
      return res.json({ success: true, data: null });
    }

    // Get members (without sensitive data)
    const members = await orgDb.getOrgMembers(user.orgId);
    // EFFECTIVE role, not the stored column. `roleOf` unions `ownerUserId`, so
    // the billing root holds owner authority whatever their stored `orgRole`
    // says — and that divergence is reachable: another owner can demote them,
    // which changes the column and nothing else.
    //
    // Reporting the raw column then makes the roster contradict the authority
    // on the same screen: the row renders "Member" while `capabilities` for
    // that same user returns `canDeleteOrg`. Worse, a client gating a control
    // on `orgRole !== "owner"` offers an admin a remove button the server then
    // 403s, because `roleOf` disagrees with what the client was told.
    //
    // Found by a live run against real DynamoDB (ENG-954); every mocked test
    // seeded the two fields in agreement, so none of them could see it.
    const safeMembers = members.map((m) => ({
      userId: m.userId,
      email: m.email,
      displayName: m.displayName,
      orgRole: roleOf({ userId: m.userId, orgId: m.orgId, orgRole: m.orgRole }, org),
    }));

    // ENG-953: this used to spread the whole Organization record, which carries
    // org-level `connected_accounts` (with unredacted config) and the encrypted
    // per-org `secrets` map — handed to every member, not just owners. The
    // sanitizer two hundred lines below was already applied to the sibling
    // connected-accounts routes and simply never to this one.
    //
    // An explicit allowlist rather than a denylist, so a future Organization
    // field is absent here until someone deliberately adds it.
    const callerRole = roleOf({ userId, orgId: user.orgId, orgRole: user.orgRole }, org);
    return res.json({
      success: true,
      data: {
        orgId: org.orgId,
        name: org.name,
        ownerUserId: org.ownerUserId,
        brandGuidelines: org.brandGuidelines,
        marketStrategy: org.marketStrategy,
        startupProfiles: org.startupProfiles,
        connected_accounts: (org.connected_accounts || []).map(sanitizeConnectedAccountForOrgResponse),
        seoDomains: org.seoDomains,
        cmsType: org.cmsType,
        emailDomain: org.emailDomain,
        fromName: org.fromName,
        slackChannel: org.slackChannel,
        googleAnalyticsProperties: org.googleAnalyticsProperties,
        primaryAnalyticsPropertyId: org.primaryAnalyticsPropertyId,
        gaFilteredDomains: org.gaFilteredDomains,
        clarityProjects: org.clarityProjects,
        productDomain: org.productDomain,
        googleDriveFolders: org.googleDriveFolders,
        pendingInvites: org.pendingInvites,
        autoJoinEnabled: org.autoJoinEnabled,
        autoJoinDomain: org.autoJoinDomain,
        pendingDomainJoinRequests: org.pendingDomainJoinRequests,
        shareSettings: org.shareSettings,
        shareAnalyticsWithOrg: org.shareAnalyticsWithOrg,
        orgMemoryEnabled: org.orgMemoryEnabled,
        analyticsConfigSource: org.analyticsConfigSource,
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
        members: safeMembers,
        // Server-computed capabilities. Clients must gate on these rather than
        // comparing orgRole themselves — that comparison is exactly what has to
        // be updated in every UI each time a role is added, and it is why the
        // portal would silently render an admin as a plain member.
        callerRole,
        capabilities: {
          canManageOrg: can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:configure"),
          canManageMembers: can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:members:manage"),
          canManageContent: can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:content:manage"),
          canSeeAllAccounts: can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:accounts:read"),
          canDeleteOrg: can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:delete"),
        },
      },
    });
  } catch (error) {
    console.error("Error getting organization:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Update organization (owner only)
router.put("/:orgId", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId } = req.params;
    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:configure"))) {
      return res.status(403).json({ error: "Only org owners and admins can update the organization" });
    }

    // Allow updating org-level profile fields
    const allowedFields = [
      "name", "brandGuidelines", "marketStrategy", "startupProfiles",
      "connected_accounts", "seoDomains", "cmsType", "emailDomain",
      "fromName", "slackChannel", "googleAnalyticsProperties", "googleDriveFolders",
      "autoJoinEnabled",
    ];

    const updates: Partial<Organization> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        (updates as any)[field] = req.body[field];
      }
    }

    // autoJoinDomain is always derived server-side from the owner's own email
    // — never client-supplied — so an owner can't claim a domain they don't
    // belong to. Disabling clears it so a later re-enable always re-derives.
    if (updates.autoJoinEnabled !== undefined) {
      if (updates.autoJoinEnabled) {
        const ownerEmail = (req as AuthenticatedRequest).user?.email || "";
        if (!isCompanyEmail(ownerEmail)) {
          return res.status(400).json({
            error: "Auto-join can't be enabled for a personal email domain.",
          });
        }
        const domain = deriveDomainFromEmail(ownerEmail);
        if (!domain) {
          return res.status(400).json({ error: "Could not determine your email domain" });
        }
        updates.autoJoinDomain = domain;
      } else {
        (updates as any).autoJoinDomain = null;
      }
    }

    const updated = await orgDb.updateOrg(orgId, updates);
    return res.json({ success: true, data: updated });
  } catch (error) {
    console.error("Error updating organization:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Invite member (owner only)
router.post("/:orgId/invite", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId } = req.params;
    const { email } = req.body;

    if (!email || typeof email !== "string") {
      return res.status(400).json({ error: "Email is required" });
    }

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:members:manage"))) {
      return res.status(403).json({ error: "Only org owners and admins can invite members" });
    }

    // Check if user already in this org
    const targetUser = await userDb.getUserByEmail(email.toLowerCase());
    if (targetUser?.orgId === orgId) {
      return res.status(400).json({ error: "This user is already in your organization" });
    }
    if (targetUser?.orgId) {
      return res.status(400).json({ error: "This user is already in another organization" });
    }

    // Check for existing pending invite
    const pendingInvites = org.pendingInvites || [];
    if (pendingInvites.some((inv) => inv.email === email.toLowerCase())) {
      return res.status(400).json({ error: "An invite is already pending for this email" });
    }

    // Generate invite token
    const inviteToken = crypto.randomBytes(32).toString("hex");

    // Add to pending invites
    const newInvite = {
      email: email.toLowerCase(),
      inviteToken,
      invitedAt: new Date().toISOString(),
      invitedBy: userId,
    };

    await orgDb.updateOrg(orgId, {
      pendingInvites: [...pendingInvites, newInvite],
    });

    // If the invitee already has an account, stamp pendingOrgInvite so they're
    // redirected straight to accept-invite on next login instead of onboarding.
    if (targetUser) {
      await userDb.updateUser(targetUser.userId, {
        pendingOrgInvite: { orgId, inviteToken },
      });
    }

    // Send invite email
    try {
      const { emailService } = await import("../services/emailService");
      const inviteUrl = `${process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174"}/org/accept-invite?token=${inviteToken}&orgId=${orgId}`;
      const ownerUser = await userDb.getUserById(userId);
      const ownerName = ownerUser?.displayName || ownerUser?.email || "Someone";

      await emailService.sendEmail(
        email.toLowerCase(),
        `You're invited to join ${org.name} on AgentWeb`,
        `${ownerName} has invited you to join the organization "${org.name}" on AgentWeb. Visit ${inviteUrl} to accept the invitation.`,
        `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1B2549;">You're invited to join ${org.name}</h2>
          <p>${ownerName} has invited you to join their organization on AgentWeb.</p>
          <p>As a member, you'll share the organization's brand guidelines, market strategy, and connected accounts.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${inviteUrl}" style="background-color: #1976d2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
              Accept Invitation
            </a>
          </div>
          <p style="color: #666; font-size: 14px;">If you don't have an AgentWeb account yet, you'll need to create one first.</p>
          <p>Best regards,<br>The AgentWeb Team</p>
        </div>
        `
      );
    } catch (emailError) {
      console.error("Error sending org invite email:", emailError);
      // Don't fail the invite if email fails — the invite is still created
    }

    return res.json({ success: true, message: "Invitation sent" });
  } catch (error) {
    console.error("Error inviting member:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Accept invite (invited user)
router.post("/accept-invite", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, inviteToken } = req.body;

    if (!orgId || !inviteToken) {
      return res.status(400).json({ error: "orgId and inviteToken are required" });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.orgId) {
      return res.status(400).json({ error: "You are already in an organization. Leave your current org first." });
    }

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    // Find and validate the invite
    const pendingInvites = org.pendingInvites || [];
    const inviteIndex = pendingInvites.findIndex(
      (inv) => inv.inviteToken === inviteToken && inv.email === user.email
    );

    if (inviteIndex === -1) {
      return res.status(400).json({ error: "Invalid or expired invitation" });
    }

    // Add user to org first — the conditional write in joinOrg rejects a user
    // who already belongs to an org, so two concurrent accepts/approvals for the
    // same person resolve to exactly one membership. We
    // intentionally do NOT snapshot the owner's subscription tier onto the
    // member here — the org's effective tier is resolved dynamically from
    // the owner at read time (getUserSubscriptionType), which keeps members
    // in sync with owner up/downgrades and auto-revokes entitlements when
    // they leave. See ENG-288.
    const joinResult = await userDb.joinOrg(userId, orgId, "member");
    if (joinResult === "already_in_org") {
      return res.status(400).json({ error: "You are already in an organization. Leave your current org first." });
    }

    // Only remove the invite once the join actually succeeded — removing it
    // first would silently drop the invite if the atomic join lost the race.
    // (joinOrg's conditional write already cleared pendingOrgInvite on the user
    // as part of the same update.)
    const updatedInvites = [...pendingInvites];
    updatedInvites.splice(inviteIndex, 1);
    await orgDb.updateOrg(orgId, { pendingInvites: updatedInvites });

    return res.json({ success: true, message: "Successfully joined the organization" });
  } catch (error) {
    console.error("Error accepting invite:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Approve a pending domain-join request (owner only)
router.post("/:orgId/domain-requests/:requestToken/approve", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, requestToken } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:members:manage"))) {
      return res.status(403).json({ error: "Only org owners and admins can approve domain-join requests" });
    }

    const pendingRequests = org.pendingDomainJoinRequests || [];
    const requestEntry = pendingRequests.find((r) => r.requestToken === requestToken);
    if (!requestEntry) {
      return res.status(400).json({ error: "Invalid or unknown domain-join request" });
    }

    // Cheap early exit — the authoritative check is the conditional write in
    // joinOrg below, which closes the real race: the same user joining twice if
    // the domain matched multiple orgs and another owner approved first. That
    // race is not closeable by a separate read-then-write, however early — see
    // the function's doc comment.
    const targetUser = await userDb.getUserById(requestEntry.userId);
    if (!targetUser) {
      return res.status(404).json({ error: "The requesting user no longer exists" });
    }
    if (targetUser.orgId) {
      return res.status(400).json({ error: "This user is already in an organization" });
    }

    // Only remove the request from this org's pending list once the join
    // actually succeeds — removing it first would silently drop the request
    // if the atomic join loses the race, with no way to retry.
    const joinResult = await userDb.joinOrg(requestEntry.userId, orgId, "member");
    if (joinResult === "already_in_org") {
      return res.status(400).json({ error: "This user is already in an organization" });
    }

    // Same non-snapshotting join mechanics as accept-invite (see ENG-288) —
    // no tier fields copied. If this is already gone (e.g. a concurrent
    // reject beat us to it, extremely unlikely given the join already
    // succeeded above), that's fine — nothing left to clean up.
    await orgDb.removeDomainJoinRequest(orgId, requestToken);

    return res.json({ success: true, message: "Domain-join request approved" });
  } catch (error) {
    console.error("Error approving domain-join request:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Reject a pending domain-join request (owner only)
router.post("/:orgId/domain-requests/:requestToken/reject", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, requestToken } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:members:manage"))) {
      return res.status(403).json({ error: "Only org owners and admins can reject domain-join requests" });
    }

    const removed = await orgDb.removeDomainJoinRequest(orgId, requestToken);
    if (!removed) {
      return res.status(404).json({ error: "No pending domain-join request found for this token" });
    }

    return res.json({ success: true, message: "Domain-join request rejected" });
  } catch (error) {
    console.error("Error rejecting domain-join request:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Cancel a pending invite (owner only)
router.delete("/:orgId/invite/:email", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, email } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:members:manage"))) {
      return res.status(403).json({ error: "Only org owners and admins can cancel invites" });
    }

    const pendingInvites = org.pendingInvites || [];
    const filtered = pendingInvites.filter((inv) => inv.email !== decodeURIComponent(email).toLowerCase());

    if (filtered.length === pendingInvites.length) {
      return res.status(404).json({ error: "No pending invite found for this email" });
    }

    await orgDb.updateOrg(orgId, { pendingInvites: filtered });

    // Clear the pendingOrgInvite stamp on the user account if they have one
    const targetEmail = decodeURIComponent(email).toLowerCase();
    const targetUser = await userDb.getUserByEmail(targetEmail);
    if (targetUser?.pendingOrgInvite?.orgId === orgId) {
      await userDb.updateUser(targetUser.userId, { pendingOrgInvite: null });
    }

    return res.json({ success: true, message: "Invite cancelled" });
  } catch (error) {
    console.error("Error cancelling invite:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Change a member's role. This is the whole of succession: there is no
// transfer-ownership primitive, because no system surveyed has one — you promote
// someone, then leave. Guarded by the last-one-out invariant so a demote can
// never orphan the org.
router.patch("/:orgId/members/:memberId/role", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, memberId } = req.params;
    const { role } = req.body ?? {};

    if (role !== "owner" && role !== "admin" && role !== "member") {
      return res.status(400).json({ error: "role must be one of: owner, admin, member" });
    }

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:members:manage"))) {
      return res.status(403).json({ error: "Only org owners and admins can change member roles" });
    }

    const member = await userDb.getUserById(memberId);
    if (!member || member.orgId !== orgId) {
      return res.status(404).json({ error: "Member not found in this organization" });
    }

    const caller = await userDb.getUserById(userId);
    const callerRole = roleOf({ userId, orgId, orgRole: caller?.orgRole }, org);
    const currentRole = roleOf({ userId: memberId, orgId, orgRole: member.orgRole }, org);

    // Only an owner may mint or remove another owner. An admin promoting someone
    // to owner would be a self-service privilege escalation: admins cannot delete
    // the org, owners can, so admin->owner->delete would route around the one
    // authority admins are deliberately denied.
    if ((role === "owner" || currentRole === "owner") && callerRole !== "owner") {
      return res.status(403).json({ error: "Only an owner can grant or revoke owner" });
    }

    if (currentRole === role) {
      return res.json({ success: true, message: `Member is already ${role}`, role });
    }

    // Demoting the billing root is a no-op that reports success. `roleOf`
    // unions `ownerUserId`, so this writes the column and moves no authority:
    // they remain an owner, the roster still says owner, and nothing the
    // caller wanted actually happened. Observed live on the test env — the
    // request returned 200 twice while the target kept `canDeleteOrg`.
    //
    // Refuse it and say why, rather than succeeding at nothing. Succession is
    // still available: promote someone else, then this user leaves, which
    // moves the billing root with them.
    if (memberId === org.ownerUserId && role !== "owner") {
      return res.status(409).json({
        error: "This member owns the organization's billing, so changing their role here would not actually change anything. To hand the organization over, make someone else an owner first — billing moves to them automatically when this member leaves or is removed.",
      });
    }

    // Demoting the last owner orphans the org. This is the path Better Auth
    // missed (better-auth#3651) — remove and leave were guarded, changeRole was
    // not.
    if (currentRole === "owner" && !(await anotherOwnerRemains(org, memberId))) {
      return res.status(409).json({
        error: "Cannot demote the only owner. Promote another member to owner first.",
      });
    }

    await userDb.updateUser(memberId, { orgRole: role });
    return res.json({ success: true, message: `Member role set to ${role}`, role });
  } catch (error) {
    console.error("Error changing member role:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Remove member (owner only)
router.delete("/:orgId/members/:memberId", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, memberId } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:members:manage"))) {
      return res.status(403).json({ error: "Only org owners and admins can remove members" });
    }

    if (memberId === userId) {
      return res.status(400).json({ error: "Cannot remove yourself. Use the leave endpoint or delete the org." });
    }

    const member = await userDb.getUserById(memberId);
    if (!member || member.orgId !== orgId) {
      return res.status(404).json({ error: "Member not found in this organization" });
    }

    if (roleOf({ userId: memberId, orgId, orgRole: member.orgRole }, org) === "owner") {
      // Removing an owner revokes their ownership, so it answers to the same
      // authority as demoting one. Without this an admin — who is 403'd by the
      // role route above for exactly this reason — could reach the same end by
      // deleting the owner outright, which is the strictly larger action.
      const caller = await userDb.getUserById(userId);
      if (roleOf({ userId, orgId, orgRole: caller?.orgRole }, org) !== "owner") {
        return res.status(403).json({ error: "Only an owner can remove an owner" });
      }
      if (!(await anotherOwnerRemains(org, memberId))) {
        return res.status(409).json({
          error: "Cannot remove the only owner. Promote another member to owner first.",
        });
      }
    }

    if (!(await reassignBillingRootOnDeparture(org, memberId, userId))) {
      return res.status(409).json({
        error: "Cannot remove the only owner. Promote another member to owner first.",
      });
    }
    await userDb.clearOrgMembership(memberId);
    return res.json({ success: true, message: "Member removed" });
  } catch (error) {
    console.error("Error removing member:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Leave organization (member only, not owner)
router.post("/:orgId/leave", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    const user = await userDb.getUserById(userId);
    if (!user || user.orgId !== orgId) {
      return res.status(400).json({ error: "You are not a member of this organization" });
    }

    // Owners may leave — as long as they are not the last one. This used to
    // block on `ownerUserId === userId` and point at a transfer-ownership route
    // that was never built, which made the primary owner permanently unable to
    // leave their own org.
    if (roleOf({ userId, orgId, orgRole: user.orgRole }, org) === "owner" && !(await anotherOwnerRemains(org, userId))) {
      return res.status(409).json({
        error: "You are the only owner. Promote another member to owner before leaving.",
      });
    }

    if (!(await reassignBillingRootOnDeparture(org, userId))) {
      return res.status(409).json({
        error: "You are the only owner. Promote another member to owner before leaving.",
      });
    }
    await userDb.clearOrgMembership(userId);
    return res.json({ success: true, message: "Left the organization" });
  } catch (error) {
    console.error("Error leaving organization:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Delete organization (owner only)
router.delete("/:orgId", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:delete"))) {
      return res.status(403).json({ error: "Only org owners can delete the organization" });
    }

    // Remove all members from the org
    const members = await orgDb.getOrgMembers(orgId);
    for (const member of members) {
      await userDb.updateUser(member.userId, { orgId: null as any, orgRole: null as any });
    }

    // Delete the org
    await orgDb.deleteOrg(orgId);

    return res.json({ success: true, message: "Organization deleted" });
  } catch (error) {
    console.error("Error deleting organization:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Get members with connected accounts info (for the shared accounts view)
router.get("/:orgId/connected-accounts", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId } = req.params;

    const user = await userDb.getUserById(userId);
    if (!user || user.orgId !== orgId) {
      return res.status(403).json({ error: "Not a member of this organization" });
    }

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    // Collect connected accounts from all members with "addedBy" labels
    const members = await orgDb.getOrgMembers(orgId);
    const allAccounts: Array<any> = [];

    // Org-level accounts first
    if (org.connected_accounts) {
      for (const account of org.connected_accounts) {
        allAccounts.push({
          ...sanitizeConnectedAccountForOrgResponse(account),
          addedBy: "organization",
          addedByName: org.name,
          isOrgLevel: true,
        });
      }
    }

    const ownerCanManageOrgAccounts = canSeeAllOrgAccounts(user, org);

    // Member personal accounts. Members only see accounts explicitly shared with the org.
    // Org owners see all member-connected accounts so they can decide what becomes an
    // org resource without copying credentials between users.
    for (const member of members) {
      if (member.connected_accounts) {
        for (const account of member.connected_accounts) {
          if (!account.sharedWithOrg && !ownerCanManageOrgAccounts) continue;
          allAccounts.push({
            ...sanitizeConnectedAccountForOrgResponse(account),
            addedBy: member.userId,
            addedByName: member.displayName || member.email,
            isOrgLevel: false,
            canManageSharing: ownerCanManageOrgAccounts,
            adminManaged: !!account.sharedWithOrg,
          });
        }
      }
    }

    return res.json({ success: true, data: allAccounts });
  } catch (error) {
    console.error("Error getting org connected accounts:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Toggle sharing a personal connected account with the org
router.patch("/connected-accounts/:platform/:accountId/share", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const user = await userDb.getUserById(userId);
    if (!user?.orgId) {
      return res.status(403).json({ error: "You are not a member of any organization" });
    }

    const { platform, accountId } = req.params;
    const { sharedWithOrg } = req.body;
    if (typeof sharedWithOrg !== "boolean") {
      return res.status(400).json({ error: "sharedWithOrg must be a boolean" });
    }

    const org = await orgDb.getOrgById(user.orgId);
    if (!org) {
      return res.status(404).json({ error: "Organization not found" });
    }

    const requesterIsOwner = canManageOrgAccounts(user, org);
    let accountOwner = user;
    let accounts = user.connected_accounts || [];
    let idx = accounts.findIndex(
      (a: any) => a.platform === platform && a.account_id === accountId
    );

    if (idx === -1 && requesterIsOwner) {
      const members = await orgDb.getOrgMembers(user.orgId);
      for (const member of members) {
        const memberAccounts = member.connected_accounts || [];
        const memberIdx = memberAccounts.findIndex(
          (a: any) => a.platform === platform && a.account_id === accountId
        );
        if (memberIdx !== -1) {
          accountOwner = member;
          accounts = memberAccounts;
          idx = memberIdx;
          break;
        }
      }
    }

    if (idx === -1) {
      return res.status(404).json({ error: "Connected account not found" });
    }

    if (accountOwner.userId !== userId && !requesterIsOwner) {
      return res.status(403).json({ error: "Only the org owner can manage another member's connected accounts" });
    }

    const existingAccount = accounts[idx];
    if (existingAccount.sharedWithOrg && sharedWithOrg === false && !requesterIsOwner) {
      return res.status(403).json({ error: "Only the org owner can unshare an org-shared connected account" });
    }

    const updated = [...accounts];
    updated[idx] = { ...updated[idx], sharedWithOrg };
    await userDb.updateUser(accountOwner.userId, { connected_accounts: updated } as any);

    return res.json({
      success: true,
      sharedWithOrg,
      ownerUserId: accountOwner.userId,
      adminManaged: requesterIsOwner,
    });
  } catch (error) {
    console.error("Error toggling connected account org sharing:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Copy owner's profile data to org (owner only)
router.post("/:orgId/copy-profile", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId } = req.params;
    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!(await callerCan(userId, org, "org:configure"))) {
      return res.status(403).json({ error: "Only org owners and admins can copy profile data" });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Copy only shared profile fields from user to org
    // Currently only brand guidelines and market strategy are shared at org level
    const profileFields: Partial<Organization> = {};
    if (user.brandGuidelines) profileFields.brandGuidelines = user.brandGuidelines;
    const marketStrategy = buildOrgMarketStrategyForCopy(user);
    if (marketStrategy) profileFields.marketStrategy = marketStrategy;

    if (Object.keys(profileFields).length === 0) {
      return res.json({ success: true, message: "No profile data to copy", copiedFields: [] });
    }

    const updated = await orgDb.updateOrg(orgId, profileFields);
    return res.json({
      success: true,
      message: "Profile data copied to organization",
      copiedFields: Object.keys(profileFields),
      data: updated,
    });
  } catch (error) {
    console.error("Error copying profile to org:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
