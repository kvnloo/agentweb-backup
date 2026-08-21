import express from "express";
import { userDb, orgDb } from "../services/db";
import type { OrgShareSettings } from "../services/db";
import { TOGGLEABLE_FEATURES, ALWAYS_ON_FEATURES } from "../services/orgShareService";
import { can } from "../services/orgAuthz";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return res.status(404).json({ message: "No org" });
    const org = await orgDb.getOrgById(user.orgId);
    if (!org) return res.status(404).json({ message: "Org not found" });
    // Keep the revision inside the settings snapshot. The deployed portal
    // preserves unknown fields when it merges the response into local state,
    // so it will return this token on save without a coordinated frontend
    // release. The PATCH strips it before persistence.
    return res.json({
      shareSettings: {
        ...(org.shareSettings ?? {}),
        _revision: org.updatedAt ?? null,
      },
    });
  } catch (e) {
    console.error("Error fetching org share-settings:", e);
    return res.status(500).json({ message: "Failed to fetch share-settings" });
  }
});

function validateSettings(body: any): OrgShareSettings | { error: string } {
  if (!body || typeof body !== "object") return { error: "shareSettings is required" };
  for (const f of TOGGLEABLE_FEATURES) {
    const v = body[f];
    if (!v || typeof v.enabled !== "boolean" || !Array.isArray(v.editors)) {
      return { error: `Invalid value for ${f}` };
    }
  }
  for (const f of ALWAYS_ON_FEATURES) {
    const v = body[f];
    if (!v || !Array.isArray(v.editors)) return { error: `Invalid value for ${f}` };
  }
  return body as OrgShareSettings;
}

router.patch("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return res.status(404).json({ message: "No org" });
    const org = await orgDb.getOrgById(user.orgId);
    if (!can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, "org:configure")) {
      return res.status(403).json({ message: "Org owners and admins only" });
    }

    // This route replaces the complete shareSettings document. Bind the write
    // to the revision the client actually read; using the fresh route read
    // above would let a stale client snapshot pass the compare-and-swap guard.
    const incomingWithRevision = req.body?.shareSettings;
    if (!incomingWithRevision || typeof incomingWithRevision !== "object") {
      return res.status(400).json({ message: "shareSettings is required" });
    }
    if (!("_revision" in incomingWithRevision)) {
      return res.status(428).json({
        message: "A share-settings revision is required — reload and try again",
      });
    }
    const { _revision: expectedUpdatedAt, ...incoming } = incomingWithRevision;
    if (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "string") {
      return res.status(400).json({ message: "shareSettings._revision must be a string or null" });
    }

    // Back-fill newer features from the org's existing settings when an older client
    // omits them, so pre-deploy portals keep working.
    if (incoming && typeof incoming === "object") {
      if (incoming.analytics === undefined) {
        incoming.analytics = org?.shareSettings?.analytics ?? { enabled: false, editors: [] };
      }
      if (incoming.crm === undefined) {
        incoming.crm = org?.shareSettings?.crm ?? { enabled: true, editors: [] };
      }
    }
    const validated = validateSettings(incoming);
    if ("error" in validated) return res.status(400).json({ message: validated.error });

    const members = await orgDb.getOrgMembers(user.orgId);
    const memberIds = new Set(members.map((m: { userId: string }) => m.userId));
    for (const f of [...TOGGLEABLE_FEATURES, ...ALWAYS_ON_FEATURES]) {
      const editors: string[] = (validated as any)[f].editors;
      for (const e of editors) {
        if (!memberIds.has(e)) {
          return res.status(400).json({ message: `editor ${e} is not a member of this org (feature ${f})` });
        }
      }
    }

    // Guarded write: this route replaces the whole shareSettings document
    // from client input, so an overlapping writer (grant, cleanup) must fail
    // the conditional write rather than be silently overwritten. A conflict
    // means the client's snapshot is stale — retrying it server-side would
    // erase the concurrent writer's change, so surface 409 and let the
    // client re-read and resubmit against fresh state.
    try {
      const nextRevision = await orgDb.updateShareSettings(
        user.orgId,
        validated,
        expectedUpdatedAt === null ? undefined : expectedUpdatedAt,
      );
      return res.json({
        shareSettings: { ...validated, _revision: nextRevision },
      });
    } catch (writeError: any) {
      if (writeError?.code === "ConditionalCheckFailedException") {
        return res.status(409).json({
          message: "Share settings were changed by another request — reload and try again",
        });
      }
      throw writeError;
    }
  } catch (e) {
    console.error("Error updating org share-settings:", e);
    return res.status(500).json({ message: "Failed to update share-settings" });
  }
});

export default router;
