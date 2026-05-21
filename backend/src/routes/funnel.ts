import express from "express";
import { authenticateToken } from "../middleware/auth";
import { validateFunnelStages, FunnelStage } from "../services/funnelService";
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import { userDb, orgDb } from "../services/db";
import { isFeatureEffectivelyEnabled, canEditItem, listOrgVisibleItems } from "../services/orgShareService";

const router = express.Router();
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";

router.use(authenticateToken);

interface FunnelConfig {
  id: string;
  name: string;
  stages: FunnelStage[];
  createdAt: string;
  updatedAt: string;
}

interface FunnelsSettings {
  [funnelId: string]: FunnelConfig;
}

interface FunnelListItem {
  configId: string;
  name: string;
  stages: FunnelStage[];
  createdAt: string;
  updatedAt: string;
  ownerUserId: string;
  ownerName: string;
  canEdit: boolean;
}

// Helper function to get all funnels for a user
async function getUserFunnels(userId: string): Promise<FunnelsSettings> {
  const result = await dynamodb.get({
    TableName: `${TABLE_PREFIX}AW-Settings`,
    Key: {
      settingName: `funnels_${userId}`,
    },
  }).promise();

  return (result.Item?.funnels as FunnelsSettings) || {};
}

// Helper function to save funnels for a user
async function saveUserFunnels(userId: string, funnels: FunnelsSettings): Promise<void> {
  await dynamodb.put({
    TableName: `${TABLE_PREFIX}AW-Settings`,
    Item: {
      settingName: `funnels_${userId}`,
      funnels,
      updatedAt: new Date().toISOString(),
    },
  }).promise();
}

// Get all funnels visible to the caller (own + org-shared), each tagged with
// its owner and a server-computed canEdit flag.
router.get("/", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await userDb.getUserById(userId);
    const ownName = (user as any)?.name || (user as any)?.email || "You";

    const toItems = (
      funnels: FunnelsSettings,
      ownerUserId: string,
      ownerName: string,
      canEdit: boolean,
    ): FunnelListItem[] =>
      Object.values(funnels).map((f) => ({
        configId: `funnel:${f.id}`,
        name: f.name,
        stages: f.stages,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
        ownerUserId,
        ownerName,
        canEdit,
      }));

    // No org → only the caller's own funnels.
    if (!user?.orgId) {
      const own = toItems(await getUserFunnels(userId), userId, ownName, true);
      return res.json({ success: true, funnels: own, truncated: false });
    }

    const org = await orgDb.getOrgById(user.orgId);
    const orgLike = org
      ? { orgId: org.orgId, ownerUserId: org.ownerUserId, shareSettings: org.shareSettings }
      : null;
    const userLike = { userId, orgId: user.orgId, orgRole: (user as any).orgRole };
    // Editors / org owner may edit every org funnel; plain members may not.
    // canEditItem on a non-self item reduces to the caller's editor/admin
    // status, so it is identical for every other member — compute it once.
    const canEditOthers = canEditItem(
      { userId: "__other__" }, userLike, orgLike, user.orgId, "funnels",
    );

    const result = await listOrgVisibleItems<FunnelListItem>({
      callerUserId: userId,
      orgId: user.orgId,
      featureEnabled: isFeatureEffectivelyEnabled(userLike, orgLike, "funnels"),
      getOwnerItems: async () => toItems(await getUserFunnels(userId), userId, ownName, true),
      getMemberIds: async () => (await orgDb.getOrgMembers(user.orgId!)).map((m) => m.userId),
      getItemsForOwner: async (ownerUserId) => {
        const ownerUser = await userDb.getUserById(ownerUserId);
        const name = (ownerUser as any)?.name || (ownerUser as any)?.email || "Org member";
        return toItems(await getUserFunnels(ownerUserId), ownerUserId, name, canEditOthers);
      },
      getId: (f) => f.configId,
    });

    res.json({ success: true, funnels: result.items, truncated: result.truncated });
  } catch (error: any) {
    console.error("Error fetching funnels:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching funnels",
      error: error.message,
    });
  }
});

// Get a specific funnel
router.get("/:configId", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { configId } = req.params;

    // Remove "funnel:" prefix if present
    const funnelId = configId.replace(/^funnel:/, "");

    const funnels = await getUserFunnels(userId);
    const funnel = funnels[funnelId];

    if (!funnel) {
      return res.status(404).json({
        success: false,
        message: "Funnel not found",
      });
    }

    res.json({
      success: true,
      funnel: {
        configId: `funnel:${funnel.id}`,
        name: funnel.name,
        stages: funnel.stages,
        createdAt: funnel.createdAt,
        updatedAt: funnel.updatedAt,
      },
    });
  } catch (error: any) {
    console.error("Error fetching funnel:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching funnel",
      error: error.message,
    });
  }
});

// Create a new funnel
router.post("/", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { name, stages } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Funnel name is required",
      });
    }

    if (!stages || !Array.isArray(stages)) {
      return res.status(400).json({
        success: false,
        message: "Stages array is required",
      });
    }

    // Validate stages
    const errors = validateFunnelStages(stages);
    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid funnel configuration",
        errors,
      });
    }

    const funnelId = uuidv4();
    const now = new Date().toISOString();

    const funnels = await getUserFunnels(userId);
    funnels[funnelId] = {
      id: funnelId,
      name: name.trim(),
      stages,
      createdAt: now,
      updatedAt: now,
    };

    await saveUserFunnels(userId, funnels);

    res.json({
      success: true,
      message: "Funnel created successfully",
      funnel: {
        configId: `funnel:${funnelId}`,
        name: name.trim(),
        stages,
        createdAt: now,
        updatedAt: now,
      },
    });
  } catch (error: any) {
    console.error("Error creating funnel:", error);
    res.status(500).json({
      success: false,
      message: "Error creating funnel",
      error: error.message,
    });
  }
});

// Update an existing funnel
router.put("/:configId", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { configId } = req.params;
    const { name, stages } = req.body;

    // Remove "funnel:" prefix if present
    const funnelId = configId.replace(/^funnel:/, "");

    if (name && !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Funnel name cannot be empty",
      });
    }

    if (stages) {
      if (!Array.isArray(stages)) {
        return res.status(400).json({
          success: false,
          message: "Stages must be an array",
        });
      }

      const errors = validateFunnelStages(stages);
      if (errors.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid funnel configuration",
          errors,
        });
      }
    }

    const funnels = await getUserFunnels(userId);

    if (!funnels[funnelId]) {
      return res.status(404).json({
        success: false,
        message: "Funnel not found",
      });
    }

    // Update the funnel
    if (name) {
      funnels[funnelId].name = name.trim();
    }
    if (stages) {
      funnels[funnelId].stages = stages;
    }
    funnels[funnelId].updatedAt = new Date().toISOString();

    await saveUserFunnels(userId, funnels);

    res.json({
      success: true,
      message: "Funnel updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating funnel:", error);
    res.status(500).json({
      success: false,
      message: "Error updating funnel",
      error: error.message,
    });
  }
});

// Delete a funnel
router.delete("/:configId", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { configId } = req.params;

    // Remove "funnel:" prefix if present
    const funnelId = configId.replace(/^funnel:/, "");

    const funnels = await getUserFunnels(userId);

    if (!funnels[funnelId]) {
      return res.status(404).json({
        success: false,
        message: "Funnel not found",
      });
    }

    delete funnels[funnelId];
    await saveUserFunnels(userId, funnels);

    res.json({
      success: true,
      message: "Funnel deleted successfully",
    });
  } catch (error: any) {
    console.error("Error deleting funnel:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting funnel",
      error: error.message,
    });
  }
});

export default router;
