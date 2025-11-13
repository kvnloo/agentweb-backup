import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";

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

    // Return market strategy data or default structure
    const marketStrategy = user.marketStrategy || {
      businessOverview: "",
      competitors: [],
      icp: [],
    };

    console.log(`[MARKET STRATEGY DEBUG] Returning market strategy data`);
    return res.json({
      success: true,
      data: marketStrategy,
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

    // Get existing market strategy or default
    const existingMarketStrategy = user.marketStrategy || {
      businessOverview: "",
      competitors: [],
      icp: [],
    };

    // Merge: only update fields that are provided
    const marketStrategy = {
      businessOverview: businessOverview !== undefined ? businessOverview : existingMarketStrategy.businessOverview,
      competitors: competitors !== undefined ? competitors : existingMarketStrategy.competitors,
      icp: icp !== undefined ? icp : existingMarketStrategy.icp,
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