import express from "express";
import AWS from "aws-sdk";
import { userDb, orgDb, taskDb } from "../services/db";
import { workPlanService } from "../services/workPlanService";
import { skillService } from "../services/skillService";
import { htmlTemplateService } from "../services/htmlTemplateService";
import {
  getLandingPagesByOwner,
  deleteLandingPageByRecord,
  transferLandingPageOwner,
} from "../services/v0Service";
import { OWNED_FEATURES, OwnedFeature } from "../services/orgShareService";
import { can, roleOf } from "../services/orgAuthz";
import { billingRootMayDepart, reassignBillingRootOnDeparture } from "./org";

const router = express.Router();

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";

// ── Funnel helpers (funnels are stored one item per user in AW-Settings) ─────

/** Read a user's funnels map from AW-Settings (keyed `funnels_<userId>`). */
async function getUserFunnelsMap(userId: string): Promise<Record<string, any>> {
  const result = await dynamodb
    .get({
      TableName: `${TABLE_PREFIX}AW-Settings`,
      Key: { settingName: `funnels_${userId}` },
    })
    .promise();
  return (result.Item?.funnels as Record<string, any>) || {};
}

/** Write a user's funnels map back to AW-Settings. */
async function saveUserFunnelsMap(userId: string, funnels: Record<string, any>): Promise<void> {
  await dynamodb
    .put({
      TableName: `${TABLE_PREFIX}AW-Settings`,
      Item: {
        settingName: `funnels_${userId}`,
        funnels,
        updatedAt: new Date().toISOString(),
      },
    })
    .promise();
}

/** Count the funnels owned by a user. */
async function getUserFunnelCount(userId: string): Promise<number> {
  return Object.keys(await getUserFunnelsMap(userId)).length;
}

// ── GET /:userId/removal-preview ───────────────────────────────────────────

router.get("/:userId/removal-preview", async (req, res) => {
  try {
    const callerId = (req as any).user.userId;
    const caller = await userDb.getUserById(callerId);
    const callerOrg = caller?.orgId ? await orgDb.getOrgById(caller.orgId) : null;
    if (!caller?.orgId || !can({ userId: callerId, orgId: caller.orgId, orgRole: caller.orgRole }, callerOrg, "org:members:manage")) {
      return res.status(403).json({ message: "Org owners and admins only" });
    }

    const target = await userDb.getUserById(req.params.userId);
    if (!target) {
      return res.status(404).json({ message: "Member not found in your org" });
    }
    if (target.orgId !== caller.orgId) {
      return res.status(404).json({ message: "Member not found in your org" });
    }

    const [taskList, templates, landingPages, workPlans, skills, funnelsCount] = await Promise.all([
      taskDb.getTasksByUserId(target.userId).then((a) => (a ?? []).length),
      htmlTemplateService.getTemplatesByOwner(target.userId).then((a) => a.length),
      getLandingPagesByOwner(target.userId).then((a) => a.length),
      workPlanService.getWorkPlansByOwner(target.userId).then((a) => a.length),
      skillService.getSkillsByOwner(target.userId).then((a) => a.length),
      getUserFunnelCount(target.userId),
    ]);

    res.json({
      userId: target.userId,
      itemCounts: {
        knowledgeBase: taskList,
        htmlTemplates: templates,
        landingPages,
        workPlans,
        skills,
        funnels: funnelsCount,
      },
    });
  } catch (e) {
    console.error("Error in removal-preview:", e);
    res.status(500).json({ message: "Failed to fetch removal preview" });
  }
});

// ── POST /:userId/remove ───────────────────────────────────────────────────

const PER_FEATURE_CAP = 10000;
const CONCURRENCY = 25;

type Decision = "transfer" | "delete" | "leave";

router.post("/:userId/remove", async (req, res) => {
  try {
    const callerId = (req as any).user.userId;
    const callerEmail = (req as any).user.email as string;
    const caller = await userDb.getUserById(callerId);
    const callerOrg = caller?.orgId ? await orgDb.getOrgById(caller.orgId) : null;
    if (!caller?.orgId || !can({ userId: callerId, orgId: caller.orgId, orgRole: caller.orgRole }, callerOrg, "org:members:manage")) {
      return res.status(403).json({ message: "Org owners and admins only" });
    }

    // can() above returns false for a null org, so reaching here proves it is
    // set. Narrowed here, before any use, rather than beside the first one.
    if (!callerOrg) {
      return res.status(404).json({ message: "Organization not found" });
    }

    if (req.body?.confirm !== true) {
      return res.status(400).json({ message: "confirm:true required" });
    }

    const target = await userDb.getUserById(req.params.userId);
    if (!target || target.orgId !== caller.orgId) {
      return res.status(404).json({ message: "Member not found in your org" });
    }

    // Both guards were missing here, unlike the sibling route in routes/org.ts.
    // Without them an owner could remove themselves, leaving org.ownerUserId
    // pointing at a non-member and the org permanently unadministrable.
    if (target.userId === callerId) {
      return res.status(400).json({ message: "Cannot remove yourself. Use the leave endpoint or delete the org." });
    }
    if (roleOf({ userId: target.userId, orgId: target.orgId, orgRole: target.orgRole }, callerOrg) === "owner") {
      // Owner-only, for the same reason PATCH /:orgId/members/:memberId/role is:
      // this revokes ownership. It matters more here than there, because this
      // route also honours `transfer` decisions — an admin removing an owner
      // would inherit that owner's landing pages, skills, work plans and
      // knowledge base in the same request.
      if (roleOf({ userId: callerId, orgId: caller.orgId, orgRole: caller.orgRole }, callerOrg) !== "owner") {
        return res.status(403).json({ message: "Only an owner can remove an owner" });
      }
      const members = await orgDb.getOrgMembers(caller.orgId);
      const anotherOwner = members.some(
        (m: any) => m.userId !== target.userId &&
          roleOf({ userId: m.userId, orgId: m.orgId, orgRole: m.orgRole }, callerOrg) === "owner");
      if (!anotherOwner) {
        return res.status(409).json({ message: "Cannot remove the only owner. Promote another member to owner first." });
      }
      // Claim the owner-loss slot on the org item. Without this, a concurrent
      // departure that passed the same roster read proceeds too and the org
      // ends with no owner (Greptile, #2297).
      if (!(await orgDb.claimOwnerChange(caller.orgId, callerOrg.ownerEpoch ?? 0))) {
        return res.status(409).json({ message: "Another owner change is in progress. Please retry." });
      }
    }

    // Every refusal must precede the asset work below. This route honours
    // `transfer` and `delete` decisions, so a 409 raised after those loops
    // leaves the target still in the org with their landing pages, skills,
    // work plans and knowledge base already moved to the caller or destroyed —
    // strictly worse than the removal it was refusing (Greptile, #2297).
    //
    // Placing it here rather than beside the departure write is the point: the
    // departure write is the LAST thing this handler does, which is exactly
    // why the gate was ineffective when it lived next to it.
    const mayGo = await billingRootMayDepart(callerOrg, target.userId);
    if (!mayGo.ok) {
      return res.status(409).json({ message: mayGo.error, code: mayGo.code });
    }
    // Move the billing pointer BEFORE any asset work, not after.
    //
    // It has no ordering dependency on the transfers — it only has to happen
    // by the time the member is gone. Running it afterwards meant its failure
    // path returned 409 with the target's landing pages, skills, work plans
    // and knowledge base already transferred or destroyed, and the target
    // still in the org. Two reads of the roster can also disagree under GSI
    // lag, so "the guard already proved a successor exists" is not something
    // the later call can rely on (Greptile, #2297).
    //
    // Failing here instead leaves nothing mutated. If the asset work below
    // fails after this point, the pointer has moved to another owner and the
    // target is still a member — consistent, and harmless, unlike the reverse.
    if (!(await reassignBillingRootOnDeparture(callerOrg, target.userId, callerId))) {
      return res.status(409).json({ message: "Cannot remove the only owner. Promote another member to owner first." });
    }

    const decisions: Partial<Record<OwnedFeature, Decision>> = req.body?.decisions || {};
    for (const f of OWNED_FEATURES) {
      const d = decisions[f];
      if (!d || !["transfer", "delete", "leave"].includes(d)) {
        return res.status(400).json({ message: `Invalid decision for ${f}: ${d}` });
      }
    }

    // Cap pre-check — fetch counts before making any writes
    // htmlTemplates uses bulk helpers so no per-item pre-check needed, but we still count
    for (const f of OWNED_FEATURES) {
      if (decisions[f] === "leave") continue;
      const items = await fetchItemsForFeature(target.userId, f);
      if (items.length > PER_FEATURE_CAP) {
        return res.status(400).json({ error: "BULK_UPDATE_TOO_LARGE", feature: f, count: items.length });
      }
    }

    const summary: Record<string, { updated: number; deleted: number; errors: string[] }> = {};

    for (const f of OWNED_FEATURES) {
      const d = decisions[f]!;
      summary[f] = { updated: 0, deleted: 0, errors: [] };
      if (d === "leave") continue;

      // htmlTemplates uses a single bulk call (no per-item loop)
      if (f === "htmlTemplates") {
        try {
          if (d === "transfer") {
            const count = await htmlTemplateService.transferAllTemplates(
              target.userId,
              callerId,
              callerEmail,
            );
            summary[f].updated = count;
          } else if (d === "delete") {
            const count = await htmlTemplateService.deleteAllTemplates(
              target.userId,
              callerEmail,
            );
            summary[f].deleted = count;
          }
        } catch (e: any) {
          summary[f].errors.push(`htmlTemplates/bulk: ${e?.message ?? e}`);
        }
        continue;
      }

      const items = await fetchItemsForFeature(target.userId, f);

      // Bounded concurrency — use a shared queue with fixed worker count
      const queue = [...items];
      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, () =>
        (async () => {
          while (queue.length) {
            const item = queue.shift();
            if (!item) break;
            try {
              if (d === "transfer") {
                await transferItemOwner(item, f, target.userId, callerId);
                summary[f].updated++;
              } else if (d === "delete") {
                await deleteItem(item, f, target.userId);
                summary[f].deleted++;
              }
            } catch (e: any) {
              summary[f].errors.push(`${f}/${getItemId(item, f)}: ${e?.message ?? e}`);
            }
          }
        })()
      );
      await Promise.all(workers);
    }

    // Carry the billing root with the departure, exactly as the sibling route
    // in routes/org.ts does. This route was missed when that landed, and it is
    // the one the portal's remove dialog actually calls — so the fix shipped
    // without covering the path a human uses.
    // Clear org membership on the target user
    await userDb.clearOrgMembership(target.userId);
    // Prune editor lists
    await orgDb.pruneEditorListsForUser(caller.orgId, target.userId);

    res.json({ summary });
  } catch (e) {
    console.error("Error removing member:", e);
    res.status(500).json({ message: "Failed to remove member" });
  }
});

// ── Per-feature helpers (used for all features except htmlTemplates) ────────

async function fetchItemsForFeature(userId: string, f: OwnedFeature): Promise<any[]> {
  switch (f) {
    case "knowledgeBase":  return (await taskDb.getTasksByUserId(userId)) ?? [];
    case "htmlTemplates":  return htmlTemplateService.getTemplatesByOwner(userId);
    case "landingPages":   return getLandingPagesByOwner(userId);
    case "workPlans":      return workPlanService.getWorkPlansByOwner(userId);
    case "skills":         return skillService.getSkillsByOwner(userId);
    case "funnels":        return Object.values(await getUserFunnelsMap(userId));
    case "analytics":      return [];
  }
}

function getItemId(item: any, f: OwnedFeature): string {
  switch (f) {
    case "knowledgeBase":  return item.taskId;
    case "htmlTemplates":  return item.template_id;
    case "landingPages":   return item.id;
    case "workPlans":      return item.planId;
    case "skills":         return item.skillId;
    case "funnels":        return item.id;
    case "analytics":      return item.id ?? "";
  }
}

async function transferItemOwner(
  item: any,
  f: OwnedFeature,
  ownerId: string,
  newOwnerId: string,
): Promise<void> {
  switch (f) {
    case "knowledgeBase":
      await taskDb.updateTaskOwner(item.taskId, newOwnerId);
      return;
    case "htmlTemplates":
      // handled via bulk helper above; should not reach here
      return;
    case "landingPages":
      await transferLandingPageOwner(item.id, newOwnerId);
      return;
    case "workPlans":
      await workPlanService.transferOwner(item.planId, newOwnerId);
      return;
    case "skills":
      await skillService.transferOwner(item.skillId, newOwnerId);
      return;
    case "funnels": {
      const [ownerFunnels, recipientFunnels] = await Promise.all([
        getUserFunnelsMap(ownerId),
        getUserFunnelsMap(newOwnerId),
      ]);
      const funnel = ownerFunnels[item.id];
      if (!funnel) return;
      recipientFunnels[item.id] = funnel;
      delete ownerFunnels[item.id];
      await saveUserFunnelsMap(newOwnerId, recipientFunnels);
      await saveUserFunnelsMap(ownerId, ownerFunnels);
      return;
    }
    case "analytics":
      // analytics has no per-user items to transfer
      return;
  }
}

async function deleteItem(item: any, f: OwnedFeature, ownerId: string): Promise<void> {
  switch (f) {
    case "knowledgeBase":
      await taskDb.deleteTask(item.taskId);
      return;
    case "htmlTemplates":
      // handled via bulk helper above; should not reach here
      return;
    case "landingPages":
      await deleteLandingPageByRecord(item);
      return;
    case "workPlans":
      await workPlanService.deleteWorkPlan(item.planId);
      return;
    case "skills":
      await skillService.deleteSkill(item.skillId);
      return;
    case "funnels": {
      const ownerFunnels = await getUserFunnelsMap(ownerId);
      if (!(item.id in ownerFunnels)) return;
      delete ownerFunnels[item.id];
      await saveUserFunnelsMap(ownerId, ownerFunnels);
      return;
    }
    case "analytics":
      // analytics has no per-user items to delete
      return;
  }
}

export default router;
