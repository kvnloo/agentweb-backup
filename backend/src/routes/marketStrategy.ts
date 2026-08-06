import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";
import { userDb, orgDb } from "../services/db";
import { canEditItem } from "../services/orgShareService";
import { resolveOrgProfileField } from "../services/orgProfileResolver";

const router = Router();
const dynamodb = new DynamoDB.DocumentClient();

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

console.log(`[MARKET STRATEGY DEBUG] Using table prefix: ${TABLE_PREFIX}`);
console.log(`[MARKET STRATEGY DEBUG] Users table: ${TABLE_PREFIX}AW-Users`);

// Get user's market strategy
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    console.log(`[MARKET STRATEGY DEBUG] GET request for user: ${userId}`);

    if (!userId) {
      console.log(`[MARKET STRATEGY DEBUG] No userId provided in request`);
      return res.status(401).json({ error: "User ID not provided" });
    }

    console.log(
      `[MARKET STRATEGY DEBUG] Querying table: ${TABLE_PREFIX}AW-Users with UserIdIndex`
    );

    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      })
      .promise();

    console.log(
      `[MARKET STRATEGY DEBUG] Query result count: ${result.Items?.length || 0}`
    );

    const users = result.Items || [];

    if (users.length === 0) {
      console.log(`[MARKET STRATEGY DEBUG] User not found in database`);
      return res.status(404).json({ error: "User not found" });
    }

    const user = users[0];
    console.log(`[MARKET STRATEGY DEBUG] Found user: ${user.email}`);

    // If user is in an org, read market strategy from the org — falling back to
    // the org owner's user record when the org was created without copying the
    // owner's profile over, so the page does not silently go blank (ENG-927).
    let marketStrategy = user.marketStrategy;
    let isOrgLevel = false;
    if (user.orgId) {
      const org = await orgDb.getOrgById(user.orgId);
      if (org) {
        marketStrategy = await resolveOrgProfileField(user, org, "marketStrategy");
        isOrgLevel = true;
      }
    }

    // Return market strategy data or default structure
    const data = marketStrategy || {
      businessOverview: "",
      competitors: [],
      icp: [],
    };

    console.log(`[MARKET STRATEGY DEBUG] Returning market strategy data`);
    return res.json({
      success: true,
      data,
      isOrgLevel,
    });
  } catch (error) {
    console.error("[MARKET STRATEGY DEBUG] Error in GET /market-strategy:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Save user's market strategy (supports partial updates)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { businessOverview, competitors, icp } = req.body;

    console.log(`[MARKET STRATEGY DEBUG] POST request for user: ${userId}`);

    if (!userId) {
      console.log(`[MARKET STRATEGY DEBUG] No userId provided in request`);
      return res.status(401).json({ error: "User ID not provided" });
    }

    // At least one field must be provided
    if (businessOverview === undefined && competitors === undefined && icp === undefined) {
      console.log(`[MARKET STRATEGY DEBUG] No fields provided in request body`);
      return res.status(400).json({
        success: false,
        error: "At least one field must be provided: businessOverview, competitors, or icp",
      });
    }

    console.log(
      `[MARKET STRATEGY DEBUG] Querying table: ${TABLE_PREFIX}AW-Users with UserIdIndex`
    );

    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      })
      .promise();

    console.log(
      `[MARKET STRATEGY DEBUG] Query result count: ${result.Items?.length || 0}`
    );

    const users = result.Items || [];

    if (users.length === 0) {
      console.log(`[MARKET STRATEGY DEBUG] User not found in database`);
      return res.status(404).json({ error: "User not found" });
    }

    const user = users[0];
    console.log(`[MARKET STRATEGY DEBUG] Found user: ${user.email}`);

    // If user is in an org, load the org record once for both auth check and existing-data merge
    let existingSource = user.marketStrategy;
    if (user.orgId) {
      const org = await orgDb.getOrgById(user.orgId);

      // Gate: only org admin OR users in marketingStrategy.editors may write
      const allowed = canEditItem(
        { userId: org?.ownerUserId } as any,
        { userId: user.userId, orgId: user.orgId, orgRole: user.orgRole as "owner" | "member" | undefined },
        org,
        user.orgId,
        "marketingStrategy",
      );
      if (!allowed) {
        return res.status(403).json({ message: "Not authorized to edit marketing strategy" });
      }

      if (org) {
        // Merge onto the org's strategy, or the owner's when the org record was
        // never populated — otherwise a partial save wipes the fields the caller
        // did not touch (ENG-927).
        existingSource =
          (await resolveOrgProfileField(user, org, "marketStrategy")) || null;
      }

      const existingMarketStrategyMerged = existingSource || {
        businessOverview: "",
        competitors: [],
        icp: [],
      };

      const now = new Date().toISOString();
      const marketStrategy = {
        businessOverview: businessOverview !== undefined ? businessOverview : existingMarketStrategyMerged.businessOverview,
        competitors: competitors !== undefined ? competitors : existingMarketStrategyMerged.competitors,
        icp: icp !== undefined ? icp : existingMarketStrategyMerged.icp,
        createdAt: (existingMarketStrategyMerged as any).createdAt || now,
        updatedAt: now,
      };

      await orgDb.updateOrg(user.orgId, { marketStrategy });
      console.log(`[MARKET STRATEGY DEBUG] Updated org ${user.orgId} market strategy`);
      return res.json({
        success: true,
        data: marketStrategy,
        message: "Market strategy saved successfully (org-level)",
      });
    }

    // Solo user (no org): merge and save to user record
    const existingMarketStrategyMerged = existingSource || {
      businessOverview: "",
      competitors: [],
      icp: [],
    };

    const now = new Date().toISOString();
    const marketStrategy = {
      businessOverview: businessOverview !== undefined ? businessOverview : existingMarketStrategyMerged.businessOverview,
      competitors: competitors !== undefined ? competitors : existingMarketStrategyMerged.competitors,
      icp: icp !== undefined ? icp : existingMarketStrategyMerged.icp,
      createdAt: (existingMarketStrategyMerged as any).createdAt || now,
      updatedAt: now,
    };

    // Update user record with market strategy data
    const updateParams = {
      TableName: `${TABLE_PREFIX}AW-Users`,
      Key: {
        email: user.email,
      },
      UpdateExpression: "SET marketStrategy = :marketStrategy, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":marketStrategy": marketStrategy,
        ":updatedAt": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    };

    console.log(`[MARKET STRATEGY DEBUG] Updating user record with market strategy`);

    const updateResult = await dynamodb.update(updateParams).promise();

    console.log(`[MARKET STRATEGY DEBUG] User record updated successfully`);

    return res.json({
      success: true,
      data: marketStrategy,
      message: "Market strategy saved successfully",
    });
  } catch (error) {
    console.error("[MARKET STRATEGY DEBUG] Error in POST /market-strategy:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

export default router; 