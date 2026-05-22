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
import { TOGGLEABLE_FEATURES, ToggleableFeature } from "../services/orgShareService";

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
    if (!caller?.orgId || caller.orgRole !== "owner") {
      return res.status(403).json({ message: "Org owner only" });
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
    if (!caller?.orgId || caller.orgRole !== "owner") {
      return res.status(403).json({ message: "Org owner only" });
    }

    if (req.body?.confirm !== true) {
      return res.status(400).json({ message: "confirm:true required" });
    }

    const target = await userDb.getUserById(req.params.userId);
    if (!target || target.orgId !== caller.orgId) {
      return res.status(404).json({ message: "Member not found in your org" });
    }

    const decisions: Partial<Record<ToggleableFeature, Decision>> = req.body?.decisions || {};
    for (const f of TOGGLEABLE_FEATURES) {
      const d = decisions[f];
      if (!d || !["transfer", "delete", "leave"].includes(d)) {
        return res.status(400).json({ message: `Invalid decision for ${f}: ${d}` });
      }
    }

    // Cap pre-check — fetch counts before making any writes
    // htmlTemplates uses bulk helpers so no per-item pre-check needed, but we still count
    for (const f of TOGGLEABLE_FEATURES) {
      if (decisions[f] === "leave") continue;
      const items = await fetchItemsForFeature(target.userId, f);
      if (items.length > PER_FEATURE_CAP) {
        return res.status(400).json({ error: "BULK_UPDATE_TOO_LARGE", feature: f, count: items.length });
      }
    }

    const summary: Record<string, { updated: number; deleted: number; errors: string[] }> = {};

    for (const f of TOGGLEABLE_FEATURES) {
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

async function fetchItemsForFeature(userId: string, f: ToggleableFeature): Promise<any[]> {
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

function getItemId(item: any, f: ToggleableFeature): string {
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
  f: ToggleableFeature,
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

async function deleteItem(item: any, f: ToggleableFeature, ownerId: string): Promise<void> {
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
