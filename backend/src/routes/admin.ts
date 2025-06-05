import express from "express";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { userDb, taskDb, subscriberDb } from "../services/db";
import { waitlistDb } from "../services/waitlistDb";
import { emailService } from "../services/emailService";
import { chatbotDb, ChatSession } from "../services/chatbotService";
import { DynamoDB } from "aws-sdk";

const router = express.Router();

// Apply authentication and admin middleware to all routes
router.use(authenticateToken);
router.use(isAdmin);

// Get all users
router.get("/users", async (req, res) => {
  try {
    const users = await userDb.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error("Error getting users:", error);
    res.status(500).json({ message: "Error fetching users" });
  }
});

// Get a single user by ID
router.get("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await userDb.getUserById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    console.error("Error getting user:", error);
    res.status(500).json({ message: "Error fetching user" });
  }
});

// Deactivate user
router.post("/users/:userId/deactivate", async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user exists and is not already deactivated
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isAdmin) {
      return res.status(403).json({ message: "Cannot deactivate admin users" });
    }

    if (user.isActive === false) {
      return res.status(400).json({ message: "User is already deactivated" });
    }

    const updatedUser = await userDb.deactivateUser(userId);
    res.json(updatedUser);
  } catch (error) {
    console.error("Error deactivating user:", error);
    res.status(500).json({ message: "Error deactivating user" });
  }
});

// Get waitlist entries
router.get("/waitlist", async (req, res) => {
  try {
    const { lastEvaluatedKey } = req.query;
    const result = await waitlistDb.list(lastEvaluatedKey as any);
    res.json(result);
  } catch (error) {
    console.error("Error getting waitlist:", error);
    res.status(500).json({ message: "Error fetching waitlist" });
  }
});

// Update waitlist entry status
router.put("/waitlist/:email/status", async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.body;

    if (!email || !status) {
      return res.status(400).json({ message: "Email and status are required" });
    }

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Update invitedAt timestamp for invited users
    let invitedAt;
    if (status === "invited") {
      invitedAt = new Date().toISOString();
    }

    const entry = await waitlistDb.updateStatus(email, status, invitedAt);

    // Send invitation email if status is 'invited'
    if (status === "invited") {
      try {
        await emailService.sendInvitation(email);
      } catch (emailError) {
        console.error("Error sending invitation email:", emailError);
        // Revert the status update
        await waitlistDb.updateStatus(email, "pending");
        return res
          .status(500)
          .json({ message: "Failed to send invitation email" });
      }
    }

    res.json(entry);
  } catch (error) {
    console.error("Error updating waitlist status:", error);
    res.status(500).json({ message: "Error updating waitlist status" });
  }
});

// Update waitlist entry support note
router.put("/waitlist/:email/support-note", async (req, res) => {
  try {
    const { email } = req.params;
    const { supportNote } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // supportNote can be an empty string, so we don't check for its existence specifically, just that the body field is present.
    if (typeof supportNote === "undefined") {
      return res
        .status(400)
        .json({ message: "supportNote field is required in the body" });
    }

    const entry = await waitlistDb.updateSupportNote(email, supportNote);
    if (!entry) {
      return res
        .status(404)
        .json({ message: "Waitlist entry not found or failed to update" });
    }

    res.json(entry);
  } catch (error) {
    console.error("Error updating waitlist support note:", error);
    res.status(500).json({ message: "Error updating support note" });
  }
});

// Delete waitlist entry
router.delete("/waitlist/:email", async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Optional: Check if entry exists before attempting delete, though DynamoDB delete is idempotent
    const existingEntry = await waitlistDb.getByEmail(email);
    if (!existingEntry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    const result = await waitlistDb.deleteByEmail(email);

    if (result.success) {
      res
        .status(200)
        .json({ message: `Waitlist entry for ${email} deleted successfully` });
    } else {
      // Use the message from deleteByEmail if available, otherwise a generic one
      res
        .status(500)
        .json({ message: result.message || "Failed to delete waitlist entry" });
    }
  } catch (error) {
    console.error("Error deleting waitlist entry:", error);
    // Check if error is an object and has a message property
    const errorMessage =
      typeof error === "object" && error !== null && "message" in error
        ? (error as { message: string }).message
        : "Internal server error";
    res
      .status(500)
      .json({ message: "Error deleting waitlist entry", error: errorMessage });
  }
});

// Resend invitation email
router.post("/waitlist/resend-invitation", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if waitlist entry exists and has invited status
    const entry = await waitlistDb.getByEmail(email);

    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    if (entry.status !== "invited") {
      return res.status(400).json({ message: "User has not been invited yet" });
    }

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Update the invitedAt timestamp
    const invitedAt = new Date().toISOString();
    await waitlistDb.updateStatus(email, "invited", invitedAt);

    // Send the invitation email
    try {
      await emailService.sendInvitation(email);
    } catch (emailError) {
      console.error("Error sending invitation email:", emailError);
      return res
        .status(500)
        .json({ message: "Failed to send invitation email" });
    }

    res.json({ message: "Invitation email resent successfully" });
  } catch (error) {
    console.error("Error resending invitation email:", error);
    res.status(500).json({ message: "Error resending invitation email" });
  }
});

// Get all tasks
router.get("/tasks", async (req, res) => {
  try {
    const tasks = await taskDb.getAllTasks();

    // Get latest execution for each task
    const tasksWithLatestExecution = await Promise.all(
      (tasks || []).map(async (task) => {
        const executions = await taskDb.getTaskExecutions(task.taskId);
        const latestExecution =
          executions && executions.length > 0 ? executions[0] : null;

        // Count completed and total runs
        const totalRuns = executions ? executions.length : 0;
        const completedRuns = executions
          ? executions.filter((exec) => exec.status === "completed").length
          : 0;

        return {
          ...task,
          latestRunStatus: latestExecution ? latestExecution.status : "none",
          latestRunTime: latestExecution ? latestExecution.startTime : null,
          completedRuns,
          totalRuns,
        };
      })
    );

    res.json(tasksWithLatestExecution);
  } catch (error) {
    console.error("Error getting tasks:", error);
    res.status(500).json({ message: "Error fetching tasks" });
  }
});

// Get task analytics
router.get("/analytics/tasks", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await taskDb.getTaskAnalytics(
      startDate as string,
      endDate as string
    );
    res.json(analytics);
  } catch (error) {
    console.error("Error getting task analytics:", error);
    res.status(500).json({ message: "Error fetching task analytics" });
  }
});

// Get user analytics
router.get("/analytics/users", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const analytics = await userDb.getUserAnalytics(
      startDate as string,
      endDate as string
    );
    res.json(analytics);
  } catch (error) {
    console.error("Error getting user analytics:", error);
    res.status(500).json({ message: "Error fetching user analytics" });
  }
});

// Get single task details
router.get("/tasks/:id", async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json(task);
  } catch (error) {
    console.error("Error getting task:", error);
    res.status(500).json({ message: "Error fetching task" });
  }
});

// Get task executions
router.get("/tasks/:id/executions", async (req, res) => {
  try {
    const taskId = req.params.id;
    const task = await taskDb.getTaskById(taskId);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const executions = await taskDb.getTaskExecutions(taskId);
    res.json(executions);
  } catch (error) {
    console.error("Error getting task executions:", error);
    res.status(500).json({ message: "Error fetching task executions" });
  }
});

// Get task subscribers
router.get("/tasks/:taskId/subscribers", async (req, res) => {
  try {
    const { taskId } = req.params;
    const subscribers = await subscriberDb.getTaskSubscribers(taskId);
    res.json(subscribers);
  } catch (error: any) {
    console.error("Error getting task subscribers:", error);
    res.status(500).json({ message: error.message });
  }
});

// Add subscriber to task
router.post("/tasks/:taskId/subscribers", async (req, res) => {
  try {
    const { taskId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const subscriber = await subscriberDb.addSubscriber(taskId, email);
    res.status(201).json(subscriber);
  } catch (error: any) {
    console.error("Error adding subscriber:", error);
    res.status(500).json({ message: error.message });
  }
});

// Remove subscriber from task
router.delete("/tasks/:taskId/subscribers/:email", async (req, res) => {
  try {
    const { taskId, email } = req.params;
    await subscriberDb.removeSubscriber(taskId, email);
    res.status(204).send();
  } catch (error: any) {
    console.error("Error removing subscriber:", error);
    res.status(500).json({ message: error.message });
  }
});

// Send announcement to all users
router.post("/announcements/send", async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!message || !title) {
      return res
        .status(400)
        .json({ message: "Title and message are required" });
    }

    // Get all active users
    const users = await userDb.getAllUsers();
    const activeEmails = users
      .filter((user) => user.isActive !== false) // Filter out deactivated users
      .map((user) => user.email)
      .filter(Boolean);

    // Track successful and failed emails
    const results = {
      total: activeEmails.length,
      successful: 0,
      failed: 0,
      failedEmails: [] as string[],
    };

    // Send announcement email to all active users
    await Promise.allSettled(
      activeEmails.map(async (email) => {
        try {
          await emailService.sendEmail(
            email,
            title,
            // Plain text version - strip HTML tags and decode entities
            message
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .trim(),
            // HTML version with improved formatting
            `<!DOCTYPE html>
            <html>
              <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                  body {
                    font-family: Arial, sans-serif;
                    line-height: 1.6;
                    color: #333;
                    max-width: 600px;
                    margin: 0 auto;
                    padding: 20px;
                  }
                  .header {
                    background-color: #1976d2;
                    color: white;
                    padding: 20px;
                    text-align: center;
                    border-radius: 4px 4px 0 0;
                  }
                  .content {
                    padding: 20px;
                    background: #fff;
                    border: 1px solid #ddd;
                    border-radius: 0 0 4px 4px;
                  }
                  .content p {
                    margin: 0 0 1em 0;
                  }
                  .content p:last-child {
                    margin-bottom: 0;
                  }
                  .footer {
                    text-align: center;
                    margin-top: 20px;
                    color: #666;
                    font-size: 0.9em;
                  }
                </style>
              </head>
              <body>
                <div class="header">
                  <h2 style="margin:0;padding:0;font-size:24px;">${title}</h2>
                </div>
                <div class="content">
                  ${message}
                </div>
                <div class="footer">
                  <p>This is an official announcement from AgentWeb</p>
                  <p>If you have any questions, please contact our support team at support@agentweb.pro</p>
                </div>
              </body>
            </html>`
          );
          results.successful++;
        } catch (error) {
          console.error(`Failed to send announcement to ${email}:`, error);
          results.failed++;
          results.failedEmails.push(email);
        }
      })
    );

    // Return detailed results
    res.json({
      message: `Announcement sent to ${results.successful} out of ${results.total} active users`,
      details: {
        total: results.total,
        successful: results.successful,
        failed: results.failed,
        failedEmails: results.failedEmails,
      },
    });
  } catch (error) {
    console.error("Error sending announcement:", error);
    res.status(500).json({ message: "Error sending announcement" });
  }
});

// Add the chat sessions route
router.get("/chat-sessions", async (req, res) => {
  try {
    // Get all chat sessions from DynamoDB
    const sessions = await chatbotDb.getAllSessions();

    // Sort sessions by updatedAt in descending order
    sessions.sort((a: ChatSession, b: ChatSession) => {
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    res.json(sessions);
  } catch (error) {
    console.error("Error fetching chat sessions:", error);
    res.status(500).json({ message: "Failed to fetch chat sessions" });
  }
});

// Add a route to update user role
router.put("/users/:userId/role", async (req, res) => {
  try {
    const { userId } = req.params;
    const { roles } = req.body; // Expect an array of roles

    // Validate roles
    const validRolesSet = new Set(["partner", "customer"]);

    if (!Array.isArray(roles) || roles.some((r) => !validRolesSet.has(r))) {
      return res.status(400).json({
        message:
          "Invalid roles. Must be an array containing only: partner, customer",
      });
    }

    // If roles array is empty, default to ['partner'] or handle as an error, based on desired logic.
    // For now, let's assume an empty array means removing all specific portal access, which might not be desired.
    // A common default might be ['partner'] if the array is empty, or the frontend should ensure it's not empty.
    // Let's proceed assuming frontend sends at least one valid role if user should have access.
    // If roles is empty, it implies no specific portal access. This is a valid state.

    // Get the user to ensure they exist (optional, updateUser will also check)
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update user in DynamoDB
    await userDb.updateUser(userId, {
      roles, // Pass the array of roles
    });

    res.status(200).json({ message: "User roles updated successfully" });
  } catch (error) {
    console.error("Error updating user roles:", error);
    res.status(500).json({ message: "Error updating user roles" });
  }
});

// Admin delete a configuration (typically a publicly shared one)
router.delete("/configs/:configId", async (req, res) => {
  const { configId } = req.params;
  const dynamodb = new DynamoDB.DocumentClient(); // Ensure dynamodb client is available
  const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
  const tableName = `${TABLE_PREFIX}AW-Configs`;

  try {
    // Step 1: Find the config by configId to get its owner (userId)
    const queryParams = {
      TableName: tableName,
      IndexName: "ConfigIdIndex", // Assuming GSI on configId
      KeyConditionExpression: "configId = :configId",
      ExpressionAttributeValues: {
        ":configId": configId,
      },
    };

    const queryResult = await dynamodb.query(queryParams).promise();

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return res.status(404).json({ message: "Configuration not found" });
    }

    const configToDelete = queryResult.Items[0];
    const ownerUserId = configToDelete.userId;

    // Optional: Check if it's actually a public config if desired
    // if (!configToDelete.shareWithEveryone) {
    //   return res.status(403).json({ message: 'Configuration is not publicly shared. Admin can only delete public configs via this route.' });
    // }

    // Step 2: Delete the config using its primary key (userId, configId)
    await dynamodb
      .delete({
        TableName: tableName,
        Key: {
          userId: ownerUserId, // The actual owner's userId
          configId: configId,
        },
      })
      .promise();

    res.status(204).send();
  } catch (error) {
    console.error(`Error deleting config ${configId} by admin:`, error);
    res
      .status(500)
      .json({ message: "Failed to delete configuration by admin" });
  }
});

// Get chatbot analytics summary
router.get("/analytics/chatbot-summary", async (req, res) => {
  // ... existing code ...
});

// Admin: Delete a user
router.delete("/users/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // It's good practice to check if the user exists before attempting to delete
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Prevent deletion of admin users as an additional safeguard
    if (user.isAdmin) {
      return res
        .status(403)
        .json({ message: "Cannot delete admin users. Deactivate instead." });
    }

    // Perform the deletion
    const deleteResult = await userDb.deleteUserById(userId);

    if (deleteResult.success) {
      res.status(200).json({ message: `User ${userId} deleted successfully.` });
    } else {
      res
        .status(500)
        .json({ message: deleteResult.message || "Failed to delete user." });
    }
  } catch (error) {
    console.error(`Error deleting user ${req.params.userId}:`, error);
    const errorMessage =
      typeof error === "object" && error !== null && "message" in error
        ? (error as { message: string }).message
        : "Internal server error during user deletion";
    res
      .status(500)
      .json({ message: "Error deleting user", error: errorMessage });
  }
});

export default router;
