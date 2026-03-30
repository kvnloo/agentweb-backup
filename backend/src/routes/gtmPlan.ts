import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";
import { sendGTMPlanUpdateNotifications, sendPhaseStatusReport, sendPlanStatusReport } from "../services/gtmPlanNotificationService";
import { notifySlackWorkItemCompleted } from "../services/gtmPlanService";
import { settingsService } from "../services/settingsService";
import { chatbotDb } from "../services/chatbotService";
import { agentModeService } from "../services/agentModeService";
import multer from "multer";
import { uploadFileToS3, presignS3Url } from "../utils/s3Utils";
import { MAX_FILE_SIZE } from "../config";
// generateSessionResponse and io are imported dynamically inside handlers
// to avoid loading server.ts → app.ts → templates.ts chain at import time

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Get GTM common items (read-only for customers) - MUST be before /:planId routes
router.get("/common-items", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const setting = await settingsService.getSetting("gtm_common_items");
    const categories = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
    return res.json({ success: true, data: categories });
  } catch (error) {
    console.error("Error fetching GTM common items:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch GTM common items" });
  }
});

// Get all GTM plans for user
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }


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
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const userEmail = authReq.user?.email;
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

    // Determine default DRI: use admin email for delegated access, otherwise user email
    const defaultDri = authReq.delegateInfo?.isDelegated
      ? authReq.delegateInfo.adminEmail
      : userEmail;

    const planId = `plan-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const now = new Date().toISOString();

    const newPlan = {
      planId,
      userId,
      title,
      description: description || "",
      dri: dri || defaultDri || undefined, // DRI defaults to admin email (if delegated) or user email
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

// Update a GTM plan (title, description, dri, dueDate, or phases)
router.put("/:planId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;
    const { title, description, dri, dueDate, phases } = req.body;

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

    if (dueDate !== undefined) {
      updateExpressions.push("#dueDate = :dueDate");
      expressionAttributeNames["#dueDate"] = "dueDate";
      expressionAttributeValues[":dueDate"] = dueDate || null; // Allow null to remove due date
    }

    if (phases !== undefined) {
      // Note: We allow dates to be saved even if they violate constraints
      // Frontend will show warnings to the user
      
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
      
      // Check if plan is transitioning to completed (was not completed before, now is)
      const wasCompleted = existingPlan.status === "completed";
      const isNowCompleted = planStatus === "completed";
      const justCompleted = !wasCompleted && isNowCompleted;

      updateExpressions.push("#phases = :phases");
      expressionAttributeNames["#phases"] = "phases";
      expressionAttributeValues[":phases"] = updatedPhases;

      // Update plan status based on phases
      updateExpressions.push("#status = :status");
      expressionAttributeNames["#status"] = "status";
      expressionAttributeValues[":status"] = planStatus;
      
      // Set completedAt when plan is just completed, clear it if going back to in_progress
      if (justCompleted) {
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = new Date().toISOString();
      } else if (wasCompleted && !isNowCompleted) {
        // Plan was completed but is now in progress again (phases were modified)
        updateExpressions.push("#completedAt = :completedAt");
        expressionAttributeNames["#completedAt"] = "completedAt";
        expressionAttributeValues[":completedAt"] = null;
      }
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

// Update a specific work item in a GTM plan (with notification support)
router.put("/:planId/phases/:phaseId/work-items/:workItemId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId, workItemId } = req.params;
    const { status, notes, dri, title, description, dueDate, notifications } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get the existing plan to verify ownership
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

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];

    // Find the work item
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    // Store original values for change detection
    const originalItem = workItems[workItemIndex];
    const changes: { status?: string; notes?: string; dri?: string; dueDate?: string | null } = {};

    // Check work item due date constraint (warning only, don't block)
    // Note: We allow the date to be saved even if it violates constraints
    // Frontend will show warnings to the user

    // Update the work item
    const updatedWorkItem = {
      ...originalItem,
      ...(status !== undefined && { status }),
      ...(notes !== undefined && { notes: notes || null }),
      ...(dri !== undefined && { dri: dri || null }),
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description: description || null }),
      ...(dueDate !== undefined && { dueDate: dueDate && dueDate.trim() !== "" ? dueDate.trim() : null }),
      ...(status === "completed" && originalItem.status !== "completed" && { completedAt: new Date().toISOString() }),
      ...(status !== undefined && status !== "completed" && originalItem.status === "completed" && { completedAt: null }),
    };

    // Only track actual changes for notifications
    if (status !== undefined && status !== originalItem.status) {
      changes.status = status;
    }
    if (notes !== undefined && notes !== originalItem.notes) {
      changes.notes = notes || null;
    }
    if (dri !== undefined && dri !== originalItem.dri) {
      changes.dri = dri || null;
    }
    if (dueDate !== undefined) {
      const newDueDate = dueDate && dueDate.trim() !== "" ? dueDate.trim() : null;
      const oldDueDate = originalItem.dueDate || null;
      if (newDueDate !== oldDueDate) {
        changes.dueDate = newDueDate;
      }
    }
    // Title and description changes don't trigger notifications

    workItems[workItemIndex] = updatedWorkItem;

    // Recalculate phase status based on work items
    const hasWorkItems = workItems.length > 0;
    const allItemsDone = hasWorkItems && workItems.every(
      (item: any) => item.status === "completed" || item.status === "skipped"
    );
    const updatedPhase = {
      ...phase,
      workItems,
      status: allItemsDone ? "completed" : "in_progress",
    };

    phases[phaseIndex] = updatedPhase;

    // Recalculate plan status based on phases
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every(
      (phase: any) => phase.status === "completed"
    );
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    // Check if plan is transitioning to completed
    const wasCompleted = plan.status === "completed";
    const isNowCompleted = planStatus === "completed";
    const justCompleted = !wasCompleted && isNowCompleted;

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    updateExpressions.push("#phases = :phases");
    expressionAttributeNames["#phases"] = "phases";
    expressionAttributeValues[":phases"] = phases;

    updateExpressions.push("#status = :status");
    expressionAttributeNames["#status"] = "status";
    expressionAttributeValues[":status"] = planStatus;

    updateExpressions.push("#updatedAt = :updatedAt");
    expressionAttributeNames["#updatedAt"] = "updatedAt";
    expressionAttributeValues[":updatedAt"] = new Date().toISOString();

    if (justCompleted) {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = new Date().toISOString();
    } else if (wasCompleted && !isNowCompleted) {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

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

    // Handle notifications if requested
    if (notifications && (notifications.notifyUser || notifications.notifyItemPoc || notifications.notifyPhasePoc || notifications.notifyPlanPoc)) {
      try {
        const updatedPlan = result.Attributes as any;
        if (updatedPlan) {
          await sendGTMPlanUpdateNotifications(
            updatedPlan,
            phaseId,
            workItemId,
            changes,
            notifications
          );
        }
      } catch (notificationError: any) {
        console.error("Error sending notifications:", notificationError);
        // Don't fail the request if notifications fail
      }
    }

    // Notify Slack thread if work item was just marked completed
    if (status === "completed" && originalItem.status !== "completed") {
      notifySlackWorkItemCompleted(updatedWorkItem).catch(() => {});
    }

    return res.json({
      success: true,
      data: result.Attributes,
      message: "Work item updated successfully",
    });
  } catch (error: any) {
    console.error("Error updating GTM plan work item:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

// Create a new phase in a GTM plan
router.post("/:planId/phases", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;
    const { title, description, dri, dueDate } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!title) {
      return res.status(400).json({
        success: false,
        error: "Phase title is required",
      });
    }

    // Get the existing plan to verify ownership
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

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Create new phase
    const phaseId = `phase-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const newPhase = {
      id: phaseId,
      title,
      description: description || null,
      dri: dri || null,
      status: "in_progress",
      workItems: [],
      dueDate: dueDate && dueDate.trim() !== "" ? dueDate.trim() : null,
    };

    phases.push(newPhase);

    // Recalculate plan status based on phases
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every(
      (p: any) => p.status === "completed"
    );
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const updateExpressions: string[] = [
      "#phases = :phases",
      "#status = :status",
      "#updatedAt = :updatedAt",
    ];
    const expressionAttributeNames: { [key: string]: string } = {
      "#phases": "phases",
      "#status": "status",
      "#updatedAt": "updatedAt",
    };
    const expressionAttributeValues: { [key: string]: any } = {
      ":phases": phases,
      ":status": planStatus,
      ":updatedAt": new Date().toISOString(),
    };

    // Clear completedAt if plan was completed but is now back to in_progress
    if (plan.status === "completed" && planStatus !== "completed") {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    // Update plan
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
      message: "Phase created successfully",
    });
  } catch (error: any) {
    console.error("Error creating phase:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

// Create a new work item in a phase
router.post("/:planId/phases/:phaseId/work-items", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId } = req.params;
    const { title, description, dri, dueDate } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!title) {
      return res.status(400).json({
        success: false,
        error: "Work item title is required",
      });
    }

    // Get the existing plan to verify ownership
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

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];

    // Create new work item
    const workItemId = `item-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const newWorkItem = {
      id: workItemId,
      title,
      description: description || null,
      dri: dri || null,
      status: "pending",
      notes: null,
      dueDate: dueDate && dueDate.trim() !== "" ? dueDate.trim() : null,
    };

    workItems.push(newWorkItem);

    // Update phase
    const updatedPhase = {
      ...phase,
      workItems,
      status: "in_progress", // Phase becomes in_progress when work items are added
    };

    phases[phaseIndex] = updatedPhase;

    // Recalculate plan status based on phases
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every(
      (p: any) => p.status === "completed"
    );
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const updateExpressions: string[] = [
      "#phases = :phases",
      "#status = :status",
      "#updatedAt = :updatedAt",
    ];
    const expressionAttributeNames: { [key: string]: string } = {
      "#phases": "phases",
      "#status": "status",
      "#updatedAt": "updatedAt",
    };
    const expressionAttributeValues: { [key: string]: any } = {
      ":phases": phases,
      ":status": planStatus,
      ":updatedAt": new Date().toISOString(),
    };

    // Clear completedAt if plan was completed but is now back to in_progress
    if (plan.status === "completed" && planStatus !== "completed") {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    // Update plan
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
      message: "Work item created successfully",
    });
  } catch (error: any) {
    console.error("Error creating work item:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

// Delete a phase from a GTM plan
router.delete("/:planId/phases/:phaseId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get the existing plan to verify ownership
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

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    // Remove the phase
    phases.splice(phaseIndex, 1);

    // Update the plan
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
        UpdateExpression: "SET phases = :phases",
        ExpressionAttributeValues: {
          ":phases": phases,
        },
      })
      .promise();

    // Return the updated plan
    const updatedPlan = {
      ...plan,
      phases: phases,
    };

    return res.json({
      success: true,
      data: updatedPlan,
      message: "Phase deleted successfully",
    });
  } catch (error) {
    console.error("Error in DELETE /gtm-plan/:planId/phases/:phaseId:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
});

// Delete a work item from a phase
router.delete("/:planId/phases/:phaseId/work-items/:workItemId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId, workItemId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get the existing plan to verify ownership
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

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];

    // Find the work item
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    // Remove the work item
    workItems.splice(workItemIndex, 1);

    // Update the phase
    phases[phaseIndex] = {
      ...phase,
      workItems: workItems,
    };

    // Update the plan
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: {
          planId: planId,
        },
        UpdateExpression: "SET phases = :phases",
        ExpressionAttributeValues: {
          ":phases": phases,
        },
      })
      .promise();

    // Return the updated plan
    const updatedPlan = {
      ...plan,
      phases: phases,
    };

    return res.json({
      success: true,
      data: updatedPlan,
      message: "Work item deleted successfully",
    });
  } catch (error) {
    console.error("Error in DELETE /gtm-plan/:planId/phases/:phaseId/work-items/:workItemId:", error);
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

// Send phase status report
router.post("/:planId/phases/:phaseId/send-status-report", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId } = req.params;
    const { notifications, message } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User ID not provided",
      });
    }

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: { planId: planId },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const plan = getResult.Item;

    // Verify the plan belongs to the user
    if (plan.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "You do not have permission to access this plan",
      });
    }

    // Verify phase exists
    const phase = plan.phases?.find((p: any) => p.id === phaseId);
    if (!phase) {
      return res.status(404).json({
        success: false,
        error: "Phase not found",
      });
    }

    // Send status report
    await sendPhaseStatusReport(
      plan as any,
      phaseId,
      { ...notifications, message },
      process.env.CUSTOMER_FRONTEND_URL
    );

    return res.json({
      success: true,
      message: "Phase status report sent successfully",
    });
  } catch (error: any) {
    console.error("Error sending phase status report:", error);
    res.status(500).json({
      success: false,
      message: "Error sending phase status report",
      error: error?.message || "Internal server error",
    });
  }
});

// Send plan status report
router.post("/:planId/send-status-report", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;
    const { notifications, message } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User ID not provided",
      });
    }

    // Get the existing plan
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: { planId: planId },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({
        success: false,
        error: "GTM Plan not found",
      });
    }

    const plan = getResult.Item;

    // Verify the plan belongs to the user
    if (plan.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "You do not have permission to access this plan",
      });
    }

    // Send status report
    await sendPlanStatusReport(
      plan as any,
      { ...notifications, message },
      process.env.CUSTOMER_FRONTEND_URL
    );

    return res.json({
      success: true,
      message: "Plan status report sent successfully",
    });
  } catch (error: any) {
    console.error("Error sending plan status report:", error);
    res.status(500).json({
      success: false,
      message: "Error sending plan status report",
      error: error?.message || "Internal server error",
    });
  }
});

// Add common items to a GTM plan (batch)
router.post("/:planId/add-common-items", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId } = req.params;
    const { items, targetPhaseId, newPhaseName } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "items must be a non-empty array" });
    }

    if (!targetPhaseId && !newPhaseName) {
      return res.status(400).json({ success: false, error: "Either targetPhaseId or newPhaseName is required" });
    }

    // Validate each item has a title
    for (const item of items) {
      if (!item.title || typeof item.title !== "string" || !item.title.trim()) {
        return res.status(400).json({ success: false, error: "Each item must have a title" });
      }
    }

    // Get the existing plan to verify ownership
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: { planId },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    if (getResult.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Create work items from the provided items
    const newWorkItems = items.map((item: { title: string; description?: string }) => ({
      id: `item-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      title: item.title.trim(),
      description: item.description?.trim() || null,
      dri: null,
      status: "pending",
      notes: null,
      dueDate: null,
    }));

    let targetPhase: any;

    if (targetPhaseId) {
      // Add to existing phase
      const phaseIndex = phases.findIndex((p: any) => p.id === targetPhaseId);
      if (phaseIndex === -1) {
        return res.status(404).json({ error: "Target phase not found" });
      }

      targetPhase = phases[phaseIndex];
      const workItems = targetPhase.workItems || [];
      workItems.push(...newWorkItems);

      // Recalculate phase status
      const hasWorkItems = workItems.length > 0;
      const allItemsDone = hasWorkItems && workItems.every(
        (item: any) => item.status === "completed" || item.status === "skipped"
      );

      phases[phaseIndex] = {
        ...targetPhase,
        workItems,
        status: allItemsDone ? "completed" : "in_progress",
      };
    } else if (newPhaseName) {
      // Create new phase with items
      const phaseId = `phase-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      targetPhase = {
        id: phaseId,
        title: newPhaseName.trim(),
        description: null,
        dri: null,
        status: "in_progress",
        workItems: newWorkItems,
        dueDate: null,
      };
      phases.push(targetPhase);
    }

    // Recalculate plan status
    const hasPhases = phases.length > 0;
    const allPhasesCompleted = hasPhases && phases.every(
      (p: any) => p.status === "completed"
    );
    const planStatus = allPhasesCompleted ? "completed" : "in_progress";

    const updateExpressions: string[] = [
      "#phases = :phases",
      "#status = :status",
      "#updatedAt = :updatedAt",
    ];
    const expressionAttributeNames: { [key: string]: string } = {
      "#phases": "phases",
      "#status": "status",
      "#updatedAt": "updatedAt",
    };
    const expressionAttributeValues: { [key: string]: any } = {
      ":phases": phases,
      ":status": planStatus,
      ":updatedAt": new Date().toISOString(),
    };

    // Clear completedAt if plan was completed but is now back to in_progress
    if (plan.status === "completed" && planStatus !== "completed") {
      updateExpressions.push("#completedAt = :completedAt");
      expressionAttributeNames["#completedAt"] = "completedAt";
      expressionAttributeValues[":completedAt"] = null;
    }

    const updateParams = {
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(updateParams).promise();

    return res.json({
      success: true,
      data: result.Attributes,
      message: "Common items added successfully",
    });
  } catch (error: any) {
    console.error("Error adding common items:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

// Upload an attachment to a work item
router.post("/:planId/phases/:phaseId/work-items/:workItemId/attachments", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId, workItemId } = req.params;
    const file = (req as any).file;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Get existing plan
    const getResult = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();
    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }
    if (getResult.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    // Upload to S3
    const uploadResult = await uploadFileToS3(file.buffer, file.originalname, userId, file.mimetype);
    if (!uploadResult.success) {
      return res.status(500).json({ error: "Failed to upload file to S3" });
    }

    const attachment = {
      id: `att-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      filename: file.originalname,
      size: file.size,
      contentType: file.mimetype,
      url: uploadResult.url,
      uploadedAt: new Date().toISOString(),
    };

    // Append to work item's attachments
    const workItem = workItems[workItemIndex];
    const attachments = workItem.attachments || [];
    attachments.push(attachment);
    workItems[workItemIndex] = { ...workItem, attachments };
    phases[phaseIndex] = { ...phase, workItems };

    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#phases": "phases", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
    }).promise();

    return res.json({ success: true, data: attachment });
  } catch (error: any) {
    console.error("Error uploading work item attachment:", error);
    return res.status(500).json({ success: false, error: error?.message || "Internal server error" });
  }
});

// Delete an attachment from a work item
router.delete("/:planId/phases/:phaseId/work-items/:workItemId/attachments/:attachmentId", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { planId, phaseId, workItemId, attachmentId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const getResult = await dynamodb.get({ TableName: TABLE_NAME, Key: { planId } }).promise();
    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }
    if (getResult.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    const workItem = workItems[workItemIndex];
    const attachments = workItem.attachments || [];
    const attachmentIndex = attachments.findIndex((a: any) => a.id === attachmentId);
    if (attachmentIndex === -1) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    attachments.splice(attachmentIndex, 1);
    workItems[workItemIndex] = { ...workItem, attachments };
    phases[phaseIndex] = { ...phase, workItems };

    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { planId },
      UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#phases": "phases", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":phases": phases, ":updatedAt": new Date().toISOString() },
    }).promise();

    return res.json({ success: true, message: "Attachment deleted" });
  } catch (error: any) {
    console.error("Error deleting work item attachment:", error);
    return res.status(500).json({ success: false, error: error?.message || "Internal server error" });
  }
});

// Start an Agent Mode session from a GTM work item
router.post("/:planId/phases/:phaseId/work-items/:workItemId/start-session", authenticateToken, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    const { planId, phaseId, workItemId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get the existing plan to verify ownership
    const getResult = await dynamodb
      .get({
        TableName: TABLE_NAME,
        Key: { planId },
      })
      .promise();

    if (!getResult.Item) {
      return res.status(404).json({ error: "GTM Plan not found" });
    }

    if (getResult.Item.userId !== userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const plan = getResult.Item;
    const phases = plan.phases || [];

    // Find the phase and work item
    const phaseIndex = phases.findIndex((p: any) => p.id === phaseId);
    if (phaseIndex === -1) {
      return res.status(404).json({ error: "Phase not found" });
    }

    const phase = phases[phaseIndex];
    const workItems = phase.workItems || [];
    const workItemIndex = workItems.findIndex((item: any) => item.id === workItemId);
    if (workItemIndex === -1) {
      return res.status(404).json({ error: "Work item not found" });
    }

    const workItem = workItems[workItemIndex];

    if (workItem.status !== "pending") {
      return res.status(400).json({ error: "Only pending work items can be started" });
    }

    // Create Agent Mode session
    const delegateInfo = authReq.delegateInfo;
    const session = await chatbotDb.createChatSession(
      userId,
      undefined, // pageContent
      "agent",   // portalType
      "agent-mode", // pageIdentifier
      undefined, // selectedStartupId
      undefined, // workflowId
      undefined, // executionId
      undefined, // emailCampaignTaskId
      "regular", // sessionType
      delegateInfo
    );

    // Set default model and attach GTM work item metadata to the session
    const modelToUse = await agentModeService.getDefaultModel();
    await chatbotDb.updateSessionLlmModel(session.sessionId, modelToUse);
    await chatbotDb.updateSessionGtmWorkItem(session.sessionId, { planId, phaseId, workItemId });

    // Build the initial message from work item title + description
    const initialMessage = workItem.description
      ? `${workItem.title}\n\n${workItem.description}`
      : workItem.title;

    // Convert work item attachments to the format expected by generateSessionResponse
    const workItemAttachments = (workItem.attachments || []).map((att: any) => {
      const presignedUrl = presignS3Url(att.url);
      return {
        url: presignedUrl || att.url,
        filename: att.filename,
        size: att.size,
        mimetype: att.contentType,
        uploadedAt: att.uploadedAt,
      };
    });

    // Fire-and-forget: trigger AI response generation in the background
    // generateSessionResponse handles adding the user message + generating the AI response
    // It also syncs GTM work item status (agent_in_progress → pending_review) via session.gtmWorkItem
    // Dynamic imports to avoid loading server.ts → app.ts chain at module load time
    const { generateSessionResponse } = await import('../controllers/agentModeController');
    const { io } = await import('../server');
    generateSessionResponse(session.sessionId, initialMessage, userId, modelToUse, workItemAttachments.length > 0 ? workItemAttachments : undefined)
      .then(() => {
        console.log(`GTM work item session ${session.sessionId}: AI response generated`);
        io.to(`user:${userId}`).emit("gtm-session-ready", {
          sessionId: session.sessionId,
          workItemId,
          workItemTitle: workItem.title,
        });
      })
      .catch((error) => {
        console.error(`GTM work item session ${session.sessionId}: AI response generation failed:`, error);
        io.to(`user:${userId}`).emit("gtm-session-ready", {
          sessionId: session.sessionId,
          workItemId,
          workItemTitle: workItem.title,
          error: true,
        });
      });

    // Update work item status to agent_in_progress and store session ID
    workItems[workItemIndex] = {
      ...workItem,
      status: "agent_in_progress",
      agentSessionId: session.sessionId,
    };

    phases[phaseIndex] = {
      ...phase,
      workItems,
    };

    // Update plan in DynamoDB
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { planId },
        UpdateExpression: "SET #phases = :phases, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#phases": "phases",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":phases": phases,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        workItemTitle: workItem.title,
        workItemDescription: workItem.description,
      },
      message: "Agent Mode session started",
    });
  } catch (error: any) {
    console.error("Error starting Agent Mode session from GTM work item:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Internal server error",
    });
  }
});

export default router;

