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
    return res.json({ shareSettings: org.shareSettings ?? null });
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

    // Back-fill `analytics` from the org's existing settings when an older client
    // omits it, so the not-yet-deployed customer portal keeps working.
    const incoming = req.body?.shareSettings;
    if (incoming && typeof incoming === "object" && incoming.analytics === undefined) {
      incoming.analytics = org?.shareSettings?.analytics ?? { enabled: false, editors: [] };
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
    // the conditional write rather than be silently overwritten. On conflict,
    // re-read and re-apply the analytics back-fill against the fresh state.
    const MAX_ATTEMPTS = 5;
    let toWrite = validated;
    let currentOrg = org;
    for (let attempt = 0; ; attempt++) {
      try {
        await orgDb.updateShareSettings(user.orgId, toWrite, currentOrg?.updatedAt);
        break;
      } catch (writeError: any) {
        if (writeError?.code !== "ConditionalCheckFailedException" || attempt >= MAX_ATTEMPTS - 1) {
          throw writeError;
        }
        currentOrg = await orgDb.getOrgById(user.orgId);
        if (incoming && typeof incoming === "object" && req.body?.shareSettings?.analytics === undefined) {
          toWrite = {
            ...toWrite,
            analytics: currentOrg?.shareSettings?.analytics ?? { enabled: false, editors: [] },
          };
        }
      }
    }
    return res.json({ shareSettings: toWrite });
  } catch (e) {
    console.error("Error updating org share-settings:", e);
    return res.status(500).json({ message: "Failed to update share-settings" });
  }
});

export default router;
