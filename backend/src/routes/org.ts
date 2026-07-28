import { Router, Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { userDb, orgDb, Organization } from "../services/db";
import { defaultShareSettings } from "../services/orgShareService";
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

function isOrgOwner(user: any, org: Organization): boolean {
  return org.ownerUserId === user.userId || user.orgRole === "owner";
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
      maxMembers: orgDb.ORG_MAX_MEMBERS,
      // The owner is the org's first member. Seeded directly (no transaction
      // needed — this org doesn't exist in the table until this exact call,
      // so there's no concurrent joiner to race against).
      memberCount: 1,
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
    const safeMembers = members.map((m) => ({
      userId: m.userId,
      email: m.email,
      displayName: m.displayName,
      orgRole: m.orgRole,
    }));

    return res.json({
      success: true,
      data: {
        ...org,
        members: safeMembers,
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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can update the organization" });
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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can invite members" });
    }

    // Check member count
    const memberCount = await orgDb.getOrgMemberCount(orgId);
    const pendingCount = (org.pendingInvites || []).length;
    if (memberCount + pendingCount >= org.maxMembers) {
      return res.status(400).json({ error: `Organization has reached the maximum of ${org.maxMembers} members (including pending invites)` });
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

    // Add user to org first — atomic (memberCount increment + orgId write in
    // one transaction, see joinOrgWithCapacityCheck) so two concurrent
    // accepts/approvals can never both squeeze into the last slot. We
    // intentionally do NOT snapshot the owner's subscription tier onto the
    // member here — the org's effective tier is resolved dynamically from
    // the owner at read time (getUserSubscriptionType), which keeps members
    // in sync with owner up/downgrades and auto-revokes entitlements when
    // they leave. See ENG-288.
    const joinResult = await userDb.joinOrgWithCapacityCheck(userId, orgId, "member", org.maxMembers);
    if (joinResult === "org_full") {
      return res.status(400).json({ error: "Organization is full" });
    }
    if (joinResult === "already_in_org") {
      return res.status(400).json({ error: "You are already in an organization. Leave your current org first." });
    }

    // Only remove the invite once the join actually succeeded — removing it
    // first would silently drop the invite if the atomic join lost the race.
    // (joinOrgWithCapacityCheck's transaction already cleared pendingOrgInvite
    // on the user as part of the atomic write.)
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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can approve domain-join requests" });
    }

    const pendingRequests = org.pendingDomainJoinRequests || [];
    const requestEntry = pendingRequests.find((r) => r.requestToken === requestToken);
    if (!requestEntry) {
      return res.status(400).json({ error: "Invalid or unknown domain-join request" });
    }

    // Cheap early exit — the authoritative check is the atomic transaction
    // below (joinOrgWithCapacityCheck), which closes both: (1) the same user
    // joining twice if the domain matched multiple orgs and another owner
    // approved first, and (2) two different users both squeezing into the
    // last slot when the org is nearly full. Neither race is closeable by a
    // separate read-then-write, however early — see the function's doc
    // comment.
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
    const joinResult = await userDb.joinOrgWithCapacityCheck(requestEntry.userId, orgId, "member", org.maxMembers);
    if (joinResult === "org_full") {
      return res.status(400).json({
        error: `Organization has reached the maximum of ${org.maxMembers} members. Upgrade to add more.`,
      });
    }
    if (joinResult === "already_in_org") {
      return res.status(400).json({ error: "This user is already in an organization" });
    }

    // Same non-snapshotting join mechanics as accept-invite (see ENG-288) —
    // no tier fields copied.
    const updatedRequests = pendingRequests.filter((r) => r.requestToken !== requestToken);
    await orgDb.updateOrg(orgId, { pendingDomainJoinRequests: updatedRequests });

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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can reject domain-join requests" });
    }

    const pendingRequests = org.pendingDomainJoinRequests || [];
    const updatedRequests = pendingRequests.filter((r) => r.requestToken !== requestToken);
    if (updatedRequests.length === pendingRequests.length) {
      return res.status(404).json({ error: "No pending domain-join request found for this token" });
    }

    await orgDb.updateOrg(orgId, { pendingDomainJoinRequests: updatedRequests });

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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can cancel invites" });
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

// Remove member (owner only)
router.delete("/:orgId/members/:memberId", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { orgId, memberId } = req.params;

    const org = await orgDb.getOrgById(orgId);
    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can remove members" });
    }

    if (memberId === userId) {
      return res.status(400).json({ error: "Cannot remove yourself. Use the leave endpoint or delete the org." });
    }

    const member = await userDb.getUserById(memberId);
    if (!member || member.orgId !== orgId) {
      return res.status(404).json({ error: "Member not found in this organization" });
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

    if (org.ownerUserId === userId) {
      return res.status(400).json({ error: "The owner cannot leave the organization. Transfer ownership or delete the org." });
    }

    const user = await userDb.getUserById(userId);
    if (!user || user.orgId !== orgId) {
      return res.status(400).json({ error: "You are not a member of this organization" });
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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can delete the organization" });
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

    const ownerCanManageOrgAccounts = isOrgOwner(user, org);

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

    const requesterIsOwner = isOrgOwner(user, org);
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

    if (org.ownerUserId !== userId) {
      return res.status(403).json({ error: "Only the org owner can copy profile data" });
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
