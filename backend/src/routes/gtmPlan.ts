import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";

const router = Router();
const dynamodb = new DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  }),
});

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

console.log(`[GTM PLAN] Using table prefix: ${TABLE_PREFIX}`);
console.log(`[GTM PLAN] Table name: ${TABLE_NAME}`);
console.log(`[GTM PLAN] NODE_ENV: ${process.env.NODE_ENV}`);

// Get all GTM plans for user
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    console.log(`[GTM PLAN] Querying table: ${TABLE_NAME} for user: ${userId}`);

    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
        ScanIndexForward: false, // Sort by createdAt descending (newest first)
      })
      .promise();

    const plans = result.Items || [];

    return res.json({
      success: true,
      data: plans,
    });
  } catch (error: any) {
    console.error("Error in GET /gtm-plan:", error);
    const errorMessage = error?.message || "Internal server error";
    const isTableNotFound = errorMessage.includes("ResourceNotFoundException") || 
                           errorMessage.includes("Cannot find table");
    
    return res.status(500).json({
      success: false,
      error: isTableNotFound 
        ? "GTM Plans table not found. Please run the table creation script."
        : errorMessage,
      details: process.env.NODE_ENV === "development" ? errorMessage : undefined,
    });
  }
});

// Get a specific GTM plan by ID
router.get("/:planId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const result = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!result.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    // Verify the plan belongs to the user
    if (result.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    return res.json({
      success: true,
      data: result.Item,
    });
  } catch (error) {
    console.error("Error in GET /gtm-plan/:planId:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Create a new GTM plan
router.post("/", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { title, description, dri } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!title) {
      return res.status(400).json({
        success: false,
        error: "Plan title is required",
      });
    }

    const planId = `plan-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const now = new Date().toISOString();

    const newPlan = {
      planId,
      userId,
      title,
      description: description || "",
      dri: dri || undefined, // DRI (Directly Responsible Individual) email at plan level
      status: "in_progress", // Plan starts as in_progress
      phases: [],
      createdAt: now,
      updatedAt: now,
    };

    const params = {
      TableName: TABLE_NAME,
      Item: newPlan,
    };

    await dynamodb.put(params).promise();

    return res.json({
      success: true,
      data: newPlan,
      message: "GTM Plan created successfully",
    });
  } catch (error) {
    console.error("Error in POST /gtm-plan:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Update a GTM plan (title, description, dri, or phases)
router.put("/:planId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;
    const { title, description, dri, phases } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // First, get the existing plan to verify ownership
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    // Verify the plan belongs to the user
    if (getResult.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const existingPlan = getResult.Item;
    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    // Build update expression dynamically
    if (title !== undefined) {
      updateExpressions.push("#title = :title");
      expressionAttributeNames["#title"] = "title";
      expressionAttributeValues[":title"] = title;
    }

    if (description !== undefined) {
      updateExpressions.push("#description = :description");
      expressionAttributeNames["#description"] = "description";
      expressionAttributeValues[":description"] = description;
    }

    if (dri !== undefined) {
      updateExpressions.push("#dri = :dri");
      expressionAttributeNames["#dri"] = "dri";
      expressionAttributeValues[":dri"] = dri || null; // Allow null to remove DRI
    }

    if (phases !== undefined) {
      // Check if all work items in each phase are completed or skipped
      const updatedPhases = phases.map((phase: any) => {
        // Phase is only completed if it has work items AND all are done
        const hasWorkItems = phase.workItems && phase.workItems.length > 0;
        const allItemsDone = hasWorkItems && phase.workItems.every(
          (item: any) => item.status === "completed" || item.status === "skipped"
        );
        return {
          ...phase,
          status: allItemsDone ? "completed" : "in_progress",
        };
      });

      // Check if all phases are completed to determine plan status
      const hasPhases = updatedPhases && updatedPhases.length > 0;
      const allPhasesCompleted = hasPhases && updatedPhases.every(
        (phase: any) => phase.status === "completed"
      );
      const planStatus = allPhasesCompleted ? "completed" : "in_progress";

      updateExpressions.push("#phases = :phases");
      expressionAttributeNames["#phases"] = "phases";
      expressionAttributeValues[":phases"] = updatedPhases;

      // Update plan status based on phases
      updateExpressions.push("#status = :status");
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = planStatus;
    }

    // Always update updatedAt
    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    const updateParams = {
      TableName: TABLE_NAME,
      Key: {
        planId: planId,
      },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(updateParams).promise();

    return res.json({
      success: true,
      data: result.Attributes,
      message: "GTM Plan updated successfully",
    });
  } catch (error) {
    console.error("Error in PUT /gtm-plan/:planId:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Delete a GTM plan
router.delete("/:planId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // First, verify the plan exists and belongs to the user
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    // Verify the plan belongs to the user
    if (getResult.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    // Delete the plan
    await dynamodb
      .delete({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
      })
      .promise();

    return res.json({
      success: true,
      message: "GTM Plan deleted successfully",
    });
  } catch (error) {
    console.error("Error in DELETE /gtm-plan/:planId:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

export default router;

