import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import axios from "axios";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { userDb, taskDb, subscriberDb } from "../services/db";
import { waitlistDb } from "../services/waitlistDb";
import { emailService } from "../services/emailService";
import { resendService } from "../services/resendService";
import { chatbotDb, ChatSession } from "../services/chatbotService";
import { DynamoDB } from "aws-sdk";
import { workflowDb } from "../services/workflowDb";
import { settingsService } from "../services/settingsService";

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

// Update user support note
router.put("/users/:userId/support-note", async (req, res) => {
  try {
    const { userId } = req.params;
    const { supportNote } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's support note
    const updatedUser = await userDb.updateUser(userId, { supportNote });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user support note:", error);
    res.status(500).json({ message: "Error updating support note" });
  }
});

// Update user ad account
router.put("/users/:userId/ad-account", async (req, res) => {
  try {
    const { userId } = req.params;
    const { adAccount } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's ad account
    const updatedUser = await userDb.updateUser(userId, { adAccount });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user ad account:", error);
    res.status(500).json({ message: "Error updating ad account" });
  }
});

// Update user email sender configuration
router.put("/users/:userId/email-sender", async (req, res) => {
  try {
    const { userId } = req.params;
    const { emailDomain, defaultSenderUsername, fromName } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's email sender configuration
    const updatedUser = await userDb.updateUser(userId, { 
      emailDomain, 
      defaultSenderUsername, 
      fromName 
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user email sender:", error);
    res.status(500).json({ message: "Error updating email sender" });
  }
});

// Update user slack channel
router.put("/users/:userId/slack-channel", async (req, res) => {
  try {
    const { userId } = req.params;
    const { slackChannel } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's slack channel
    const updatedUser = await userDb.updateUser(userId, { 
      slackChannel 
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user slack channel:", error);
    res.status(500).json({ message: "Error updating slack channel" });
  }
});

// Update user SEO domains (kept for backward compatibility)
router.put("/users/:userId/seo-domains", async (req, res) => {
  try {
    const { userId } = req.params;
    const { seoDomains } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate seoDomains is an array
    if (seoDomains && !Array.isArray(seoDomains)) {
      return res.status(400).json({ message: "seoDomains must be an array" });
    }

    // Validate each domain format
    if (seoDomains) {
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      for (const domain of seoDomains) {
        if (typeof domain !== 'string' || !domainRegex.test(domain.trim())) {
          return res.status(400).json({ 
            message: `Invalid domain format: ${domain}. Please use format like example.com` 
          });
        }
      }
    }

    // Update the user's SEO domains
    const updatedUser = await userDb.updateUser(userId, { 
      seoDomains: seoDomains || [] 
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user SEO domains:", error);
    res.status(500).json({ message: "Error updating SEO domains" });
  }
});

// Update user SEO/AEO configuration (SEO domains and Google Analytics Measurement ID)
router.put("/users/:userId/seo-aeo", async (req, res) => {
  try {
    const { userId } = req.params;
    const { seoDomains, googleAnalyticsPropertyId, clarityProjectId } = req.body;

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Validate seoDomains is an array if provided
    if (seoDomains !== undefined) {
      if (!Array.isArray(seoDomains)) {
        return res.status(400).json({ message: "seoDomains must be an array" });
      }

      // Validate each domain format
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
      for (const domain of seoDomains) {
        if (typeof domain !== 'string' || !domainRegex.test(domain.trim())) {
          return res.status(400).json({ 
            message: `Invalid domain format: ${domain}. Please use format like example.com` 
          });
        }
      }
    }

    // Validate Google Analytics Property ID format if provided
    // Note: The API uses Property ID (numeric), not Measurement ID (G-XXXXXXXXXX)
    if (googleAnalyticsPropertyId !== undefined && googleAnalyticsPropertyId !== null && googleAnalyticsPropertyId !== "") {
      // GA4 Property ID is numeric (e.g., 123456789)
      const gaIdRegex = /^\d+$/;
      const trimmedId = googleAnalyticsPropertyId.trim();
      if (typeof googleAnalyticsPropertyId !== 'string' || !gaIdRegex.test(trimmedId)) {
        return res.status(400).json({ 
          message: `Invalid Google Analytics Property ID format: ${googleAnalyticsPropertyId}. Please enter the numeric Property ID (e.g., 123456789). You can find this in GA4 Admin > Property Settings.` 
        });
      }
    }

    if (clarityProjectId !== undefined && clarityProjectId !== null && clarityProjectId !== "") {
      const clarityIdRegex = /^[a-zA-Z0-9_-]{6,32}$/;
      const trimmedId = clarityProjectId.trim();
      if (typeof clarityProjectId !== 'string' || !clarityIdRegex.test(trimmedId)) {
        return res.status(400).json({ 
          message: `Invalid Microsoft Clarity Project ID format: ${clarityProjectId}. Please enter the project ID (e.g., ul13e4f7fe). You can find this in Clarity project settings.` 
        });
      }
    }

    // Build update object with only provided fields
    const updateData: any = {};
    if (seoDomains !== undefined) {
      updateData.seoDomains = seoDomains;
    }
    if (googleAnalyticsPropertyId !== undefined) {
      updateData.googleAnalyticsPropertyId = googleAnalyticsPropertyId?.trim() || null;
    }
    if (clarityProjectId !== undefined) {
      updateData.clarityProjectId = clarityProjectId?.trim() || null;
    }

    // Update the user's SEO/AEO configuration
    const updatedUser = await userDb.updateUser(userId, updateData);
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user SEO/AEO configuration:", error);
    res.status(500).json({ message: "Error updating SEO/AEO configuration" });
  }
});

// Update user CMS Type
router.put("/users/:userId/cms-type", async (req, res) => {
  try {
    const { userId } = req.params;
    const { cmsType } = req.body;

    // Validate cmsType
    if (cmsType && cmsType !== "Basehub" && cmsType !== "Webflow") {
      return res.status(400).json({ message: "cmsType must be either 'Basehub' or 'Webflow'" });
    }

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Update the user's CMS Type
    const updatedUser = await userDb.updateUser(userId, { 
      cmsType: cmsType || undefined 
    });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user CMS Type:", error);
    res.status(500).json({ message: "Error updating CMS Type" });
  }
});

// Update user password
router.put("/users/:userId/password", async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;

    // Validate password
    if (!password || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters long" });
    }

    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update the user's password
    const updatedUser = await userDb.updateUser(userId, { password: hashedPassword });
    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error updating user password:", error);
    res.status(500).json({ message: "Error updating password" });
  }
});

// Create user from waitlist entry
router.post("/waitlist/:email/create-user", async (req, res) => {
  try {
    const { email } = req.params;
    const { roles = ["customer"] } = req.body;

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      // Allow free users to be created (upgraded to customer)
      if (existingUser.roles && existingUser.roles.some((role: string) => role !== 'free')) {
        return res.status(400).json({ message: "User already exists" });
      }
    }

    // Get waitlist entry
    const waitlistEntry = await waitlistDb.getByEmail(email);
    if (!waitlistEntry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    let resultUser;
    let temporaryPassword;

    if (existingUser) {
      // Update existing free user with new roles
      const updatedRoles = [...(existingUser.roles || []), ...roles];
      await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
      resultUser = {
        userId: existingUser.userId,
        email: existingUser.email,
        displayName: existingUser.displayName,
        roles: updatedRoles
      };
      
      // Send welcome email without password for existing user upgrade
      await emailService.sendWelcomeEmail(email);
    } else {
      // Create new user with waitlist data
      const generateRandomPassword = (length: number = 12) => {
        const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        let password = '';
        for (let i = 0; i < length; i++) {
          password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
        return password;
      };
      
      temporaryPassword = generateRandomPassword(16);
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

      const userId = require('uuid').v4();
      const newUser = await userDb.createUser(
        email,
        userId,
        hashedPassword,
        false, // isOAuthUser
        false, // isAdmin
        roles,
        waitlistEntry.fullName || email.split("@")[0], // displayName
        undefined, // googleId
        waitlistEntry.stripe_customer_id, // from waitlist
        waitlistEntry.companyName, // from waitlist
        waitlistEntry.useCaseCategories // from waitlist
      );

      if (!newUser) {
        return res.status(500).json({ message: "Failed to create user" });
      }

      resultUser = newUser;
      
      // Send welcome email with temporary password for new user
      await emailService.sendWelcomeEmail(email, temporaryPassword);
    }

    // Update waitlist status to completed
    await waitlistDb.updateStatus(email, 'completed');

    res.json({ 
      message: "User created successfully", 
      user: {
        userId: resultUser.userId,
        email: resultUser.email,
        displayName: resultUser.displayName,
        roles: resultUser.roles
      },
      ...(temporaryPassword && { temporaryPassword })
    });
  } catch (error) {
    console.error("Error creating user from waitlist:", error);
    res.status(500).json({ message: "Error creating user" });
  }
});

// Create delegate access token for customer portal
router.post("/users/:userId/delegate-access", async (req, res) => {
  try {
    const { userId } = req.params;
    const adminReq = req as any; // Should have admin user from middleware
    
    // Check if user exists
    const targetUser = await userDb.getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ message: "User not found" });
    }

    // Ensure target user has customer role
    if (!targetUser.roles || !targetUser.roles.includes("customer")) {
      return res.status(400).json({ 
        message: "User does not have customer portal access" 
      });
    }

    // Create delegation token
    const delegatePayload = {
      userId: targetUser.userId, // This will be the active user in the token
      email: targetUser.email,
      roles: targetUser.roles,
      isAdmin: false, // Target user permissions
      delegateAccess: {
        adminUserId: adminReq.user.userId,
        adminEmail: adminReq.user.email,
        targetUserId: targetUser.userId,
        targetEmail: targetUser.email
      }
    };

    const delegateToken = jwt.sign(
      delegatePayload,
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "24h" } // Delegate tokens expire in 24 hours for security
    );

    // Return the delegate token and customer portal URL
    const customerPortalUrl = process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174";
    
    res.json({ 
      delegateToken,
      customerPortalUrl: `${customerPortalUrl}/oauth-callback?token=${delegateToken}`,
      expiresIn: "24h"
    });
  } catch (error) {
    console.error("Error creating delegate access:", error);
    res.status(500).json({ message: "Error creating delegate access" });
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
      // Allow free users to be updated
      if (existingUser.roles && existingUser.roles.some((role: string) => role !== 'free')) {
        return res.status(400).json({ message: "User already exists" });
      }
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
        // Check if user already exists to determine email type
        const existingUser = await userDb.getUserByEmail(email);
        if (existingUser) {
          // Add customer role to existing free users so they can access customer portal
          if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
            const updatedRoles = [...existingUser.roles, 'customer'];
            await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
          }
          await emailService.sendWelcomeEmail(email); // No password = upgrade email
        } else {
          await emailService.sendInvitation(email);
        }
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

// Update waitlist entry - general endpoint for updating any waitlist fields
router.put("/waitlist/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const updates = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if waitlist entry exists
    const entry = await waitlistDb.getByEmail(email);
    if (!entry) {
      return res.status(404).json({ message: "Waitlist entry not found" });
    }

    // Use the updateDetails method which handles partial updates
    const updatedEntry = await waitlistDb.updateDetails(email, updates);
    res.json(updatedEntry);
  } catch (error) {
    console.error("Error updating waitlist entry:", error);
    res.status(500).json({ message: "Error updating waitlist entry" });
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

    // Check if user already exists (allow free users to be resent invitations)
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser && !existingUser.roles.includes('free')) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Update the invitedAt timestamp
    const invitedAt = new Date().toISOString();
    await waitlistDb.updateStatus(email, "invited", invitedAt);

    // Send the invitation email
    try {
      // Check if user already exists to determine email type
      const existingUser = await userDb.getUserByEmail(email);
      if (existingUser) {
        // Add customer role to existing free users so they can access customer portal
        if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
          const updatedRoles = [...existingUser.roles, 'customer'];
          await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
        }
        await emailService.sendWelcomeEmail(email); // No password = upgrade email
      } else {
        await emailService.sendInvitation(email);
      }
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

// Manually add someone to waitlist
router.post("/waitlist/invite", async (req, res) => {
  try {
    const {
      email,
      fullName,
      phoneNumber,
      companyName,
      useCaseCategories,
      useCaseDescription,
      requestReport,
      supportNote,
      monthlyMarketingSpend,
      businessArea,
      stripe_customer_id,
      sendInvitation = true,
      marketingChannels,
    } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    // Check if email already exists in waitlist
    const existingEntry = await waitlistDb.getByEmail(email);
    if (existingEntry) {
      return res
        .status(409)
        .json({ message: "Email already exists in waitlist" });
    }

    // Check if user already exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      // Allow free users to be added to waitlist even if they already exist
      if (!existingUser.roles.includes('free')) {
        return res.status(409).json({ message: "User already exists" });
      }
    }

    // Create waitlist entry
    const now = new Date().toISOString();
    const waitlistData = {
      email: email.toLowerCase(),
      joinedAt: now,
      status: sendInvitation ? "invited" : "pending",
      invitedAt: sendInvitation ? now : undefined,
      fullName: fullName || "",
      phoneNumber: phoneNumber || "",
      companyName: companyName || "",
      useCaseCategories: useCaseCategories || [],
      useCaseDescription: useCaseDescription || "",
      requestReport: requestReport || false,
      supportNote: supportNote || "Manually added by admin",
      monthlyMarketingSpend: monthlyMarketingSpend || "",
      businessArea: businessArea || "",
      stripe_customer_id: stripe_customer_id || "",
      marketingChannels: marketingChannels || [],
    };

    const entry = await waitlistDb.add(waitlistData);

    // Send invitation email if requested
    if (sendInvitation) {
      try {
        // Use welcome email for existing users, invitation email for new users
        if (existingUser) {
          // Add customer role to existing free users so they can access customer portal
          if (existingUser.roles && existingUser.roles.includes('free') && !existingUser.roles.includes('customer')) {
            const updatedRoles = [...existingUser.roles, 'customer'];
            await userDb.updateUser(existingUser.userId, { roles: updatedRoles });
          }
          await emailService.sendWelcomeEmail(email); // No password = upgrade email
        } else {
          await emailService.sendInvitation(email);
        }
      } catch (emailError) {
        console.error("Error sending invitation email:", emailError);
        // Optionally delete the entry or update status back to pending
        await waitlistDb.updateStatus(email, "pending");
        return res.status(500).json({
          message: "Waitlist entry created but failed to send invitation email",
          entry,
        });
      }
    }

    res.status(201).json(entry);
  } catch (error) {
    console.error("Error manually adding to waitlist:", error);
    res.status(500).json({ message: "Failed to add to waitlist" });
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

// Get Agent Mode analytics
router.get("/analytics/agent-mode", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Get all sessions
    const allSessions = await chatbotDb.getAllSessions();
    
    // Filter for Agent Mode sessions only
    const agentSessions = allSessions.filter(
      (session) => session.portalType === "agent" && !session.archived
    );

    const agentSessionsWithMessagesPromise = Promise.all(
      agentSessions.map(async (session) => {
        try {
          const sessionWithMessages = await chatbotDb.getChatSession(
            session.sessionId
          );
          return sessionWithMessages ?? session;
        } catch (error) {
          console.error(
            `Error loading messages for session ${session.sessionId}:`,
            error
          );
          return session;
        }
      })
    );
    
    // Parse date range
    const start = startDate ? new Date(startDate as string) : null;
    const end = endDate ? new Date(endDate as string) : null;
    
    // Helper to check if date is in range
    const isInRange = (dateStr: string) => {
      if (!start && !end) return true;
      const date = new Date(dateStr);
      if (start && date < start) return false;
      if (end) {
        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999); // Include entire end date
        if (date > endDate) return false;
      }
      return true;
    };
    
    // Calculate metrics
    const totalSessions = agentSessions.length;
    const newSessions = agentSessions.filter((s) => isInRange(s.createdAt)).length;
    
    // Separate scheduled and non-scheduled sessions
    const scheduledSessions = agentSessions.filter((s) => s.sessionType === "scheduled");
    const nonScheduledSessions = agentSessions.filter((s) => s.sessionType !== "scheduled");
    const totalScheduledSessions = scheduledSessions.length;
    const totalNonScheduledSessions = nonScheduledSessions.length;
    const newScheduledSessions = scheduledSessions.filter((s) => isInRange(s.createdAt)).length;
    const newNonScheduledSessions = nonScheduledSessions.filter((s) => isInRange(s.createdAt)).length;
    
    // Session types breakdown
    const sessionTypes: Record<string, number> = {};
    const sessionTypesInRange: Record<string, number> = {};
    
    agentSessions.forEach((session) => {
      const type = session.sessionType || "regular";
      sessionTypes[type] = (sessionTypes[type] || 0) + 1;
      if (isInRange(session.createdAt)) {
        sessionTypesInRange[type] = (sessionTypesInRange[type] || 0) + 1;
      }
    });
    
    // Helper function to check if user is anonymous
    const isAnonymousUser = (userId: string) => userId.startsWith('anon_');
    
    // Separate actual users and anonymous users
    const actualUserSessions = agentSessions.filter((s) => !isAnonymousUser(s.userId));
    const anonymousUserSessions = agentSessions.filter((s) => isAnonymousUser(s.userId));
    
    // Unique users - all time (actual users only)
    const uniqueUsers = new Set(actualUserSessions.map((s) => s.userId));
    const uniqueAnonymousUsers = new Set(anonymousUserSessions.map((s) => s.userId));
    
    // Sessions in date range (agent sessions only, no messages needed)
    const sessionsInRange = agentSessions.filter((s) => isInRange(s.createdAt));
    const actualSessionsInRange = actualUserSessions.filter((s) => isInRange(s.createdAt));
    const anonymousSessionsInRange = anonymousUserSessions.filter((s) => isInRange(s.createdAt));
    
    // Active users (users who used Agent Mode at least once during the period)
    const activeUsers = new Set(actualSessionsInRange.map((s) => s.userId));
    const activeAnonymousUsers = new Set(anonymousSessionsInRange.map((s) => s.userId));
    
    // Sessions before the date range (to identify returning users)
    const sessionsBeforeRange = actualUserSessions.filter((s) => {
      if (!start) return false;
      const date = new Date(s.createdAt);
      return date < start;
    });
    const usersBeforeRange = new Set(sessionsBeforeRange.map((s) => s.userId));
    
    // New users (users who used Agent Mode for the first time during the period)
    const newUsers = new Set(
      actualSessionsInRange
        .filter((s) => !usersBeforeRange.has(s.userId))
        .map((s) => s.userId)
    );
    
    // Returning users (users who used Agent Mode before the period and also during the period)
    const returningUsers = new Set(
      Array.from(activeUsers).filter((userId) => usersBeforeRange.has(userId))
    );
    
    // Calculate sessions per user metrics (only for actual users)
    const sessionsPerUser: Record<string, number> = {};
    actualSessionsInRange.forEach((session) => {
      sessionsPerUser[session.userId] = (sessionsPerUser[session.userId] || 0) + 1;
    });
    const averageSessionsPerActiveUser =
      activeUsers.size > 0
        ? actualSessionsInRange.length / activeUsers.size
        : 0;
    
    // Total unique users in range (for backward compatibility)
    const uniqueUsersInRange = activeUsers;
    
    const agentSessionsWithMessages = await agentSessionsWithMessagesPromise;

    // Messages statistics
    const totalMessages = agentSessionsWithMessages.reduce(
      (sum, s) => sum + (s.messages?.length || 0),
      0
    );
    const averageMessagesPerSession =
      totalSessions > 0 ? totalMessages / totalSessions : 0;
    
    // Messages in date range
    const messagesInRange = agentSessionsWithMessages.reduce(
      (sum, s) => (isInRange(s.createdAt) ? sum + (s.messages?.length || 0) : sum),
      0
    );
    const averageMessagesPerActiveUser =
      activeUsers.size > 0 ? messagesInRange / activeUsers.size : 0;
    
    // Messages by role
    const messagesByRole: Record<string, number> = {
      user: 0,
      assistant: 0,
      system: 0,
      tool: 0,
    };
    
    // Messages with attachments
    let messagesWithAttachments = 0;
    
    // Messages with tool calls
    let messagesWithToolCalls = 0;
    
    // Token usage statistics
    let totalTokens = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let messagesWithTokenData = 0;
    
    agentSessionsWithMessages.forEach((session) => {
      if (session.messages) {
        session.messages.forEach((message) => {
          // Count by role
          const role = message.role || "unknown";
          if (messagesByRole[role] !== undefined) {
            messagesByRole[role]++;
          }
          
          // Count messages with attachments
          if (message.metadata?.attachments && message.metadata.attachments.length > 0) {
            messagesWithAttachments++;
          }
          
          // Count messages with tool calls
          if (message.tool_calls && message.tool_calls.length > 0) {
            messagesWithToolCalls++;
          }
          if (message.metadata?.toolCalls && message.metadata.toolCalls.length > 0) {
            messagesWithToolCalls++;
          }
          
          // Count token usage
          if (message.usage) {
            totalTokens += message.usage.total_tokens || 0;
            totalPromptTokens += message.usage.prompt_tokens || 0;
            totalCompletionTokens += message.usage.completion_tokens || 0;
            messagesWithTokenData++;
          }
        });
      }
    });
    
    const averageTokensPerMessage =
      messagesWithTokenData > 0 ? totalTokens / messagesWithTokenData : 0;
    
    // Sessions with work plans
    const sessionsWithWorkPlans = agentSessions.filter(
      (s) => s.workPlan !== undefined
    ).length;
    const newSessionsWithWorkPlans = agentSessions.filter(
      (s) => s.workPlan !== undefined && isInRange(s.createdAt)
    ).length;
    
    // Shared sessions
    const sharedSessions = agentSessions.filter(
      (s) => s.shareMetadata?.isShared || s.interactiveShareMetadata?.isActive
    ).length;
    
    // Tool calls statistics
    const totalToolCalls = agentSessions.reduce((sum, s) => {
      if (!s.calledFunctions) return sum;
      return sum + Object.values(s.calledFunctions).reduce((a, b) => a + b, 0);
    }, 0);
    
    // Tool calls in date range
    const toolCallsInRange = sessionsInRange.reduce((sum, s) => {
      if (!s.calledFunctions) return sum;
      return sum + Object.values(s.calledFunctions).reduce((a, b) => a + b, 0);
    }, 0);
    
    const averageToolCallsPerSession =
      totalSessions > 0 ? totalToolCalls / totalSessions : 0;
    const averageToolCallsPerActiveUser =
      activeUsers.size > 0 ? toolCallsInRange / activeUsers.size : 0;
    
    // Sessions with tool calls
    const sessionsWithToolCalls = agentSessions.filter((s) => {
      if (s.calledFunctions && Object.keys(s.calledFunctions).length > 0) {
        return Object.values(s.calledFunctions).some((count) => count > 0);
      }
      return false;
    }).length;
    
    const sessionsWithToolCallsInRange = sessionsInRange.filter((s) => {
      if (s.calledFunctions && Object.keys(s.calledFunctions).length > 0) {
        return Object.values(s.calledFunctions).some((count) => count > 0);
      }
      return false;
    }).length;
    
    // Tool calls by function name (breakdown)
    const toolCallsByFunction: Record<string, number> = {};
    const toolCallsByFunctionInRange: Record<string, number> = {};
    
    agentSessions.forEach((session) => {
      if (session.calledFunctions) {
        Object.entries(session.calledFunctions).forEach(([functionName, count]) => {
          toolCallsByFunction[functionName] = (toolCallsByFunction[functionName] || 0) + count;
          
          if (isInRange(session.createdAt)) {
            toolCallsByFunctionInRange[functionName] = (toolCallsByFunctionInRange[functionName] || 0) + count;
          }
        });
      }
    });
    
    // Get top tools (sorted by usage)
    const topTools = Object.entries(toolCallsByFunction)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    
    const topToolsInRange = Object.entries(toolCallsByFunctionInRange)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
    
    // Daily growth data for chart - separate Scheduled and Non-Scheduled sessions
    const dailyGrowthScheduled: Record<string, number> = {};
    const dailyGrowthNonScheduled: Record<string, number> = {};
    
    agentSessions.forEach((session) => {
      if (isInRange(session.createdAt)) {
        const dateKey = new Date(session.createdAt).toISOString().split("T")[0];
        const isScheduled = session.sessionType === "scheduled";
        
        if (isScheduled) {
          dailyGrowthScheduled[dateKey] = (dailyGrowthScheduled[dateKey] || 0) + 1;
        } else {
          dailyGrowthNonScheduled[dateKey] = (dailyGrowthNonScheduled[dateKey] || 0) + 1;
        }
      }
    });
    
    // Get all unique dates from both
    const allDates = new Set([
      ...Object.keys(dailyGrowthScheduled),
      ...Object.keys(dailyGrowthNonScheduled)
    ]);
    
    // Sort daily growth by date and combine
    const sortedDailyGrowth = Array.from(allDates)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => ({
        date,
        scheduled: dailyGrowthScheduled[date] || 0,
        nonScheduled: dailyGrowthNonScheduled[date] || 0,
      }));
    
    res.json({
      totalSessions,
      newSessions,
      totalScheduledSessions,
      totalNonScheduledSessions,
      newScheduledSessions,
      newNonScheduledSessions,
      totalUsers: uniqueUsers.size,
      activeUsers: activeUsers.size,
      newUsers: newUsers.size,
      returningUsers: returningUsers.size,
      totalAnonymousUsers: uniqueAnonymousUsers.size,
      activeAnonymousUsers: activeAnonymousUsers.size,
      averageSessionsPerActiveUser: Math.round(averageSessionsPerActiveUser * 10) / 10,
      sessionTypes,
      sessionTypesInRange,
      totalMessages,
      messagesInRange,
      averageMessagesPerSession: Math.round(averageMessagesPerSession * 10) / 10,
      averageMessagesPerActiveUser: Math.round(averageMessagesPerActiveUser * 10) / 10,
      messagesByRole,
      messagesWithAttachments,
      messagesWithToolCalls,
      totalTokens,
      totalPromptTokens,
      totalCompletionTokens,
      averageTokensPerMessage: Math.round(averageTokensPerMessage * 10) / 10,
      sessionsWithWorkPlans,
      newSessionsWithWorkPlans,
      sharedSessions,
      totalToolCalls,
      toolCallsInRange,
      averageToolCallsPerSession: Math.round(averageToolCallsPerSession * 10) / 10,
      averageToolCallsPerActiveUser: Math.round(averageToolCallsPerActiveUser * 10) / 10,
      sessionsWithToolCalls,
      sessionsWithToolCallsInRange,
      toolCallsByFunction,
      toolCallsByFunctionInRange,
      topTools,
      topToolsInRange,
      dailyGrowth: sortedDailyGrowth,
    });
  } catch (error) {
    console.error("Error getting Agent Mode analytics:", error);
    res.status(500).json({ message: "Error fetching Agent Mode analytics" });
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
    if (error.message.includes('already subscribed')) {
      res.status(409).json({ message: error.message });
    } else {
      res.status(500).json({ message: error.message });
    }
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

// Helper function to generate announcement email HTML
const generateAnnouncementEmailHtml = (title: string, message: string, isTest: boolean = false) => {
  const testBanner = isTest ? `
    <div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">
      🧪 TEST EMAIL - This is a test announcement
    </div>
  ` : '';
  
  return `<!DOCTYPE html>
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
        ${testBanner}
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
    </html>`;
};

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

    // Send announcement email to all active users using Resend
    const fromEmail = "no-reply@updates.agentweb.pro";
    await Promise.allSettled(
      activeEmails.map(async (email) => {
        try {
          await resendService.sendEmail({
            from: fromEmail,
            to: email,
            subject: title,
            text: message
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .trim(),
            html: message, // HTML version - use message directly without wrapper
          });
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

// Send test announcement to specified recipients
router.post("/announcements/test", async (req, res) => {
  try {
    const { title, message, recipients } = req.body;
    if (!message || !title) {
      return res
        .status(400)
        .json({ message: "Title and message are required" });
    }
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one recipient email is required" });
    }

    // Validate email addresses
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const validEmails = recipients.filter((email: string) => emailRegex.test(email.trim()));
    const invalidEmails = recipients.filter((email: string) => !emailRegex.test(email.trim()));

    if (validEmails.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid email addresses provided" });
    }

    // Track successful and failed emails
    const results = {
      total: validEmails.length,
      successful: 0,
      failed: 0,
      failedEmails: [] as string[],
      invalidEmails: invalidEmails,
    };

    // Send test announcement email to specified recipients using Resend
    const fromEmail = "no-reply@updates.agentweb.pro";
    await Promise.allSettled(
      validEmails.map(async (email: string) => {
        try {
          // Add test banner to the message HTML
          const testBanner = `<div style="background-color: #ff9800; color: white; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 20px;">🧪 TEST EMAIL - This is a test announcement</div>`;
          const testMessage = testBanner + message;
          
          await resendService.sendEmail({
            from: fromEmail,
            to: email.trim(),
            subject: `[TEST] ${title}`,
            text: message
              .replace(/<[^>]*>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .trim(),
            html: testMessage, // HTML version - use message directly with test banner prepended
          });
          results.successful++;
        } catch (error) {
          console.error(`Failed to send test announcement to ${email}:`, error);
          results.failed++;
          results.failedEmails.push(email);
        }
      })
    );

    // Return detailed results
    res.json({
      message: `Test announcement sent to ${results.successful} out of ${results.total} recipients`,
      details: {
        total: results.total,
        successful: results.successful,
        failed: results.failed,
        failedEmails: results.failedEmails,
        invalidEmails: results.invalidEmails,
      },
    });
  } catch (error) {
    console.error("Error sending test announcement:", error);
    res.status(500).json({ message: "Error sending test announcement" });
  }
});

// Load announcement content from HTML URL
router.post("/announcements/load-from-url", async (req, res) => {
  const { url } = req.body;
  
  try {
    if (!url || typeof url !== "string") {
      return res
        .status(400)
        .json({ message: "URL is required and must be a string" });
    }

    // Validate URL format
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res
        .status(400)
        .json({ message: "Invalid URL format. Must be HTTP or HTTPS." });
    }

    console.log(`🔽 Fetching HTML content from: ${url}`);

    // Fetch the HTML content
    const response = await axios.get(url, {
      timeout: 15000, // 15 seconds timeout
      responseType: "text",
      headers: {
        "User-Agent": "AgentWeb-Backend/1.0",
      },
    });

    const html = response.data as string;
    console.log(`✅ Successfully fetched HTML, length: ${html.length}`);

    // Extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    let extractedTitle = titleMatch ? titleMatch[1].trim() : "";

    // If no title found, try to get from h1 tag
    if (!extractedTitle) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      extractedTitle = h1Match ? h1Match[1].trim() : "Announcement";
    }

    // Decode HTML entities in title
    extractedTitle = extractedTitle
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    // Extract body content
    let bodyContent = "";
    
    // Try to extract from <body> tag first
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      bodyContent = bodyMatch[1];
    } else {
      // If no body tag, use the entire HTML
      bodyContent = html;
    }

    // Remove script and style tags
    bodyContent = bodyContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");

    // Try to extract main content from common semantic tags
    const mainContentSelectors = [
      /<main[^>]*>([\s\S]*?)<\/main>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];

    for (const selector of mainContentSelectors) {
      const match = bodyContent.match(selector);
      if (match && match[1].trim().length > 50) {
        bodyContent = match[1];
        break;
      }
    }

    // Clean up the HTML content
    // Remove comments
    bodyContent = bodyContent.replace(/<!--[\s\S]*?-->/g, "");
    
    // Remove excessive whitespace but preserve structure
    bodyContent = bodyContent
      .replace(/\s+/g, " ")
      .replace(/>\s+</g, "><")
      .trim();

    // If content is too short, use the original body content
    if (bodyContent.length < 50) {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        bodyContent = bodyMatch[1]
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<!--[\s\S]*?-->/g, "")
          .trim();
      }
    }

    // Limit content length to prevent issues
    if (bodyContent.length > 50000) {
      bodyContent = bodyContent.substring(0, 50000) + "...";
    }

    return res.json({
      success: true,
      title: extractedTitle,
      message: bodyContent,
    });
  } catch (error: any) {
    console.error(`❌ Error loading HTML from URL: ${url}`, error.message);

    let errorMessage = "Failed to load HTML content";
    let statusCode = 500;

    if (error.response) {
      statusCode = error.response.status;
      errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
    } else if (error.code === "ENOTFOUND") {
      statusCode = 404;
      errorMessage = "URL not found or unreachable";
    } else if (error.code === "ETIMEDOUT") {
      statusCode = 408;
      errorMessage = "Request timeout while fetching HTML";
    } else if (error.code === "ECONNREFUSED") {
      statusCode = 503;
      errorMessage = "Connection refused";
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: error.message,
    });
  }
});

// Add the chat sessions route
router.get("/chat-sessions", async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 30;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    let lastEvaluatedKey: DynamoDB.DocumentClient.Key | undefined;

    if (cursor) {
      try {
        lastEvaluatedKey = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
      } catch (error) {
        return res.status(400).json({ message: "Invalid cursor" });
      }
    }

    const { sessions, lastEvaluatedKey: nextKey } = await chatbotDb.getRecentSessionsPage(
      limit,
      lastEvaluatedKey
    );

    // Load messages from the messages table for each session
    const sessionsWithMessages = await Promise.all(
      sessions.map(async (session) => {
        try {
          const sessionWithMessages = await chatbotDb.getChatSession(session.sessionId);
          return sessionWithMessages ?? session;
        } catch (error) {
          console.error(`Error loading messages for session ${session.sessionId}:`, error);
          return session;
        }
      })
    );

    const nextCursor = nextKey
      ? Buffer.from(JSON.stringify(nextKey)).toString("base64")
      : null;

    res.json({ sessions: sessionsWithMessages, nextCursor });
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
    const validRolesSet = new Set(["partner", "customer", "free"]);

    if (!Array.isArray(roles) || roles.some((r) => !validRolesSet.has(r))) {
      return res.status(400).json({
        message:
          "Invalid roles. Must be an array containing only: partner, customer, free",
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

// Get all workflows
router.get("/workflows", async (req, res) => {
  try {
    const workflows = await workflowDb.getAllWorkflows();

    // Get latest execution for each workflow
    const workflowsWithLatestExecution = await Promise.all(
      (workflows || []).map(async (workflow) => {
        const executions = await workflowDb.getWorkflowExecutions(
          workflow.workflowId
        );
        const latestExecution =
          executions && executions.length > 0 ? executions[0] : null;

        // Count completed and total runs
        const totalRuns = executions ? executions.length : 0;
        const completedRuns = executions
          ? executions.filter((exec) => exec.status === "completed").length
          : 0;

        // Count completed and total tasks
        const totalTasks = latestExecution?.tasks?.length || 0;
        const completedTasks = latestExecution?.tasks
          ? latestExecution.tasks.filter((task) => task.status === "completed")
              .length
          : 0;

        return {
          ...workflow,
          latestRunStatus: latestExecution ? latestExecution.status : "none",
          latestRunTime: latestExecution ? latestExecution.startTime : null,
          completedRuns,
          totalRuns,
          completedTasks,
          totalTasks,
        };
      })
    );

    // Sort workflows by latest run time in descending order
    workflowsWithLatestExecution.sort((a, b) => {
      if (!a.latestRunTime && !b.latestRunTime) return 0;
      if (!a.latestRunTime) return 1;
      if (!b.latestRunTime) return -1;
      return (
        new Date(b.latestRunTime).getTime() -
        new Date(a.latestRunTime).getTime()
      );
    });

    res.json(workflowsWithLatestExecution);
  } catch (error) {
    console.error("Error getting workflows:", error);
    res.status(500).json({ message: "Error fetching workflows" });
  }
});

// Get knowledge base metrics
router.get("/knowledge-base-metrics", async (req, res) => {
  try {
    // Get all tasks
    const tasks = await taskDb.getAllTasks() || [];
    
    // Calculate overall metrics
    const totalTasks = tasks.length;
    
    // Handle both string and number knowledgeBaseSize values - only count if size > 0
    const tasksWithKnowledgeBase = tasks.filter(task => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
      return size && size > 0;
    }).length;
    
    const totalKnowledgeBaseSize = tasks.reduce((sum, task) => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
      return sum + size;
    }, 0);
    
    const averageKnowledgeBaseSize = tasksWithKnowledgeBase > 0 ? totalKnowledgeBaseSize / tasksWithKnowledgeBase : 0;

    // Uploaded files metrics (from knowledgeBaseFiles array)
    const getUploadedFileStats = (task: any) => {
      const files = (task as any).knowledgeBaseFiles || [];
      const count = Array.isArray(files) ? files.length : 0;
      const size = Array.isArray(files)
        ? files.reduce((sum: number, f: any) => sum + (typeof f?.size === 'number' ? f.size : 0), 0)
        : 0;
      return { count, size };
    };

    const totalUploadedFiles = tasks.reduce((sum, task) => sum + getUploadedFileStats(task).count, 0);
    const totalUploadedFilesSize = tasks.reduce((sum, task) => sum + getUploadedFileStats(task).size, 0);
    const tasksWithUploadedFiles = tasks.filter(task => getUploadedFileStats(task).count > 0).length;
    const averageUploadedFilesPerTask = tasksWithUploadedFiles > 0 ? totalUploadedFiles / tasksWithUploadedFiles : 0;
    const averageUploadedFileSizePerTask = tasksWithUploadedFiles > 0 ? totalUploadedFilesSize / tasksWithUploadedFiles : 0;
    
    // Calculate public knowledge base metrics
    const publicTasks = tasks.filter(task => task.knowledgeBaseType === 'public');
    const publicTasksWithKnowledgeBase = publicTasks.filter(task => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
      return size && size > 0;
    }).length;
    const totalPublicKnowledgeBaseSize = publicTasks.reduce((sum, task) => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
      return sum + size;
    }, 0);
    const averagePublicKnowledgeBaseSize = publicTasksWithKnowledgeBase > 0 ? totalPublicKnowledgeBaseSize / publicTasksWithKnowledgeBase : 0;

    const publicUploaded = publicTasks.reduce(
      (acc, task) => {
        const { count, size } = getUploadedFileStats(task);
        acc.count += count;
        acc.size += size;
        if (count > 0) acc.tasksWithFiles += 1;
        return acc;
      },
      { count: 0, size: 0, tasksWithFiles: 0 }
    );
    const averagePublicUploadedFilesPerTask =
      publicUploaded.tasksWithFiles > 0 ? publicUploaded.count / publicUploaded.tasksWithFiles : 0;
    const averagePublicUploadedSizePerTask =
      publicUploaded.tasksWithFiles > 0 ? publicUploaded.size / publicUploaded.tasksWithFiles : 0;
    
    // Calculate private knowledge base metrics
    const privateTasks = tasks.filter(task => task.knowledgeBaseType === 'private');
    const privateTasksWithKnowledgeBase = privateTasks.filter(task => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
      return size && size > 0;
    }).length;
    const totalPrivateKnowledgeBaseSize = privateTasks.reduce((sum, task) => {
      const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
      return sum + size;
    }, 0);
    const averagePrivateKnowledgeBaseSize = privateTasksWithKnowledgeBase > 0 ? totalPrivateKnowledgeBaseSize / privateTasksWithKnowledgeBase : 0;

    const privateUploaded = privateTasks.reduce(
      (acc, task) => {
        const { count, size } = getUploadedFileStats(task);
        acc.count += count;
        acc.size += size;
        if (count > 0) acc.tasksWithFiles += 1;
        return acc;
      },
      { count: 0, size: 0, tasksWithFiles: 0 }
    );
    const averagePrivateUploadedFilesPerTask =
      privateUploaded.tasksWithFiles > 0 ? privateUploaded.count / privateUploaded.tasksWithFiles : 0;
    const averagePrivateUploadedSizePerTask =
      privateUploaded.tasksWithFiles > 0 ? privateUploaded.size / privateUploaded.tasksWithFiles : 0;
    
    // Get tasks with knowledge base details (only those with size > 0)
    const tasksWithDetails = tasks
      .filter(task => {
        const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : task.knowledgeBaseSize;
        return size && size > 0;
      })
      .map(task => {
        const size = typeof task.knowledgeBaseSize === 'string' ? parseInt(task.knowledgeBaseSize) : (task.knowledgeBaseSize || 0);
        const { count: uploadedFilesCount, size: uploadedFilesSize } = getUploadedFileStats(task);
        return {
          taskId: task.taskId,
          name: task.name,
          knowledgeBaseSize: size,
          owner: task.userId,
          type: task.knowledgeBaseType || 'private',
          uploadedFilesCount,
          uploadedFilesSize,
        };
      });

    res.json({
      totalTasks,
      tasksWithKnowledgeBase,
      totalKnowledgeBaseSize,
      averageKnowledgeBaseSize,
      uploadedFiles: {
        totalFiles: totalUploadedFiles,
        totalSize: totalUploadedFilesSize,
        tasksWithUploadedFiles,
        averageFilesPerTask: averageUploadedFilesPerTask,
        averageSizePerTask: averageUploadedFileSizePerTask,
      },
      public: {
        tasks: publicTasks.length,
        tasksWithKnowledgeBase: publicTasksWithKnowledgeBase,
        totalSize: totalPublicKnowledgeBaseSize,
        averageSize: averagePublicKnowledgeBaseSize,
        uploadedFiles: {
          totalFiles: publicUploaded.count,
          totalSize: publicUploaded.size,
          tasksWithUploadedFiles: publicUploaded.tasksWithFiles,
          averageFilesPerTask: averagePublicUploadedFilesPerTask,
          averageSizePerTask: averagePublicUploadedSizePerTask,
        },
      },
      private: {
        tasks: privateTasks.length,
        tasksWithKnowledgeBase: privateTasksWithKnowledgeBase,
        totalSize: totalPrivateKnowledgeBaseSize,
        averageSize: averagePrivateKnowledgeBaseSize,
        uploadedFiles: {
          totalFiles: privateUploaded.count,
          totalSize: privateUploaded.size,
          tasksWithUploadedFiles: privateUploaded.tasksWithFiles,
          averageFilesPerTask: averagePrivateUploadedFilesPerTask,
          averageSizePerTask: averagePrivateUploadedSizePerTask,
        },
      },
      tasks: tasksWithDetails
    });
  } catch (error) {
    console.error("Error getting knowledge base metrics:", error);
    res.status(500).json({ message: "Error fetching knowledge base metrics" });
  }
});

// Get all GTM plans from all users
router.get("/gtm-plans", async (req, res) => {
  try {
    const dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || "us-west-2",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      }),
    });

    const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
    const TABLE_NAME = `${TABLE_PREFIX}AW-GTMPlan`;

    // Scan all GTM plans (admin can see all)
    const result = await dynamodb.scan({
      TableName: TABLE_NAME,
    }).promise();

    const plans = result.Items || [];

    // Get user information for each plan
    const plansWithUsers = await Promise.all(
      plans.map(async (plan: any) => {
        try {
          const user = await userDb.getUserById(plan.userId);
          return {
            ...plan,
            userEmail: user?.email || undefined,
            userName: user?.name || undefined,
          };
        } catch (error) {
          return {
            ...plan,
            userEmail: undefined,
            userName: undefined,
          };
        }
      })
    );

    res.json({
      success: true,
      data: plansWithUsers,
    });
  } catch (error: any) {
    console.error("Error getting all GTM plans:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching GTM plans",
      error: error?.message || "Internal server error",
    });
  }
});

// Subscription Types endpoints

// Get all subscription types
router.get("/subscription-types", async (req, res) => {
  try {
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes = [];
    
    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error("Error parsing subscription types:", error);
        subscriptionTypes = [];
      }
    }
    
    // Import helper functions to expand "*" to actual lists if needed
    const subscriptionService = await import('../services/subscriptionService');
    const allAvailablePages = subscriptionService.getAllAvailablePages();
    const allAvailableFunctionCalls = await subscriptionService.getAllAvailableFunctionCalls();
    
    // If no subscription types exist, return default Basic type with actual lists
    if (subscriptionTypes.length === 0) {
      subscriptionTypes = [{
        name: "Basic",
        allowedPages: allAvailablePages, // All available pages (expanded)
        allowedFunctionCalls: allAvailableFunctionCalls // All available function calls (expanded)
      }];
    }
    
    // Normalize paths: remove "/marketing" prefix from allowedPages (for backward compatibility)
    // Also expand "*" to actual lists if present (for backward compatibility with old data)
    subscriptionTypes = await Promise.all(subscriptionTypes.map(async (type: any) => {
      // Normalize pages
      let normalizedPages = type.allowedPages.map((page: string) => {
        if (page.startsWith('/marketing/')) {
          return page.replace('/marketing', '');
        }
        return page;
      });
      
      // Expand "*" to actual list if present (for backward compatibility)
      if (normalizedPages.includes('*')) {
        normalizedPages = allAvailablePages;
      }
      
      // Expand "*" to actual list if present (for backward compatibility)
      let normalizedFunctionCalls = type.allowedFunctionCalls;
      if (normalizedFunctionCalls.includes('*')) {
        normalizedFunctionCalls = allAvailableFunctionCalls;
      }
      
      return {
        ...type,
        allowedPages: normalizedPages,
        allowedFunctionCalls: normalizedFunctionCalls
      };
    }));
    
    res.json(subscriptionTypes);
  } catch (error) {
    console.error("Error getting subscription types:", error);
    res.status(500).json({ message: "Error fetching subscription types" });
  }
});

// Create or update subscription types
router.post("/subscription-types", async (req, res) => {
  try {
    const { subscriptionTypes } = req.body;
    
    if (!Array.isArray(subscriptionTypes)) {
      return res.status(400).json({ message: "subscriptionTypes must be an array" });
    }
    
    // Import helper functions to expand "*" to actual lists
    const subscriptionService = await import('../services/subscriptionService');
    const allAvailablePages = subscriptionService.getAllAvailablePages();
    const allAvailableFunctionCalls = await subscriptionService.getAllAvailableFunctionCalls();
    
    // Validate subscription types structure, normalize paths, and expand "*" to actual lists
    const normalizedTypes = await Promise.all(subscriptionTypes.map(async (type: any) => {
      if (!type.name || typeof type.name !== "string") {
        throw new Error("Each subscription type must have a name");
      }
      if (!Array.isArray(type.allowedPages)) {
        throw new Error("Each subscription type must have allowedPages array");
      }
      if (!Array.isArray(type.allowedFunctionCalls)) {
        throw new Error("Each subscription type must have allowedFunctionCalls array");
      }
      
      // Remove "/marketing" prefix from allowedPages if present
      let normalizedPages = type.allowedPages.map((page: string) => {
        if (page.startsWith('/marketing/')) {
          return page.replace('/marketing', '');
        }
        return page;
      });
      
      // Expand "*" to actual list of pages
      if (normalizedPages.includes('*')) {
        normalizedPages = allAvailablePages;
      }
      
      // Expand "*" to actual list of function calls
      let normalizedFunctionCalls = type.allowedFunctionCalls;
      if (normalizedFunctionCalls.includes('*')) {
        normalizedFunctionCalls = allAvailableFunctionCalls;
      }
      
      return {
        ...type,
        allowedPages: normalizedPages,
        allowedFunctionCalls: normalizedFunctionCalls
      };
    }));
    
    const updatedBy = (req as any).user?.email || "unknown";
    await settingsService.setSetting(
      "subscription_types",
      JSON.stringify(normalizedTypes),
      "Customer portal subscription types configuration",
      updatedBy
    );
    
    res.json({ success: true, subscriptionTypes: normalizedTypes });
  } catch (error: any) {
    console.error("Error saving subscription types:", error);
    res.status(400).json({ message: error.message || "Error saving subscription types" });
  }
});

// Update user subscription type
router.put("/users/:userId/subscription-type", async (req, res) => {
  try {
    const { userId } = req.params;
    const { subscriptionType } = req.body;
    
    if (!subscriptionType || typeof subscriptionType !== "string") {
      return res.status(400).json({ message: "subscriptionType is required and must be a string" });
    }
    
    // Check if user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    
    // Verify subscription type exists
    const setting = await settingsService.getSetting("subscription_types");
    let subscriptionTypes = [];
    
    if (setting) {
      try {
        subscriptionTypes = JSON.parse(setting.settingValue);
      } catch (error) {
        console.error("Error parsing subscription types:", error);
      }
    }
    
    // If no subscription types defined, allow "Basic" as default
    if (subscriptionTypes.length === 0 && subscriptionType !== "Basic") {
      return res.status(400).json({ message: "Subscription type not found. Only 'Basic' is available." });
    }
    
    // Check if subscription type exists (unless it's Basic and no types are defined)
    if (subscriptionTypes.length > 0) {
      const typeExists = subscriptionTypes.some((type: any) => type.name === subscriptionType);
      if (!typeExists) {
        return res.status(400).json({ message: "Subscription type not found" });
      }
    }
    
    // Update the user's subscription type
    const updatedUser = await userDb.updateUser(userId, { subscriptionType });
    res.json(updatedUser);
  } catch (error) {
    console.error("Error updating user subscription type:", error);
    res.status(500).json({ message: "Error updating subscription type" });
  }
});

export default router;
