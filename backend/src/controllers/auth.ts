import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userDb, orgDb } from "../services/db";
import { Profile } from "passport-google-oauth20";
import { waitlistDb } from "../services/waitlistDb";
import { v4 as uuidv4 } from "uuid";
import { emailService } from "../services/emailService";
import crypto from "crypto";
import { getTierConfig, DEFAULT_PAGES } from "../services/subscriptionService";
import { syncNewUserToLeadList } from "../services/crmAutoSyncService";
import { normalizeAttribution } from "../types/attribution";
import { onUserRegistered } from "../services/contactCaptureHooks";
import { isCompanyEmail } from "../utils/validation";
import { isInitialPasswordExpired } from "../utils/secureRandom";
import { AuthenticatedRequest } from "../middleware/auth";

export const register = async (req: Request, res: Response) => {
  try {
    let {
      email,
      password,
      roles: reqRoles,
      displayName: reqDisplayName,
      utm,
      attribution,
    } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }
    if (password.length < 12) {
      return res
        .status(400)
        .json({ message: "Password must be at least 12 characters long" });
    }
    email = email.toLowerCase();

    if (!isCompanyEmail(email)) {
      return res.status(400).json({
        message: "Please use a company email address to sign up.",
        code: "personal_email_not_allowed",
      });
    }

    // Check if user exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Determine roles: use reqRoles if provided, otherwise default to ["customer"]
    const finalRoles =
      reqRoles && Array.isArray(reqRoles) && reqRoles.length > 0
        ? reqRoles
        : ["customer"];

    // Check waitlist status only for non-free users (feature-flagged via SKIP_WAITLIST_CHECK)
    const skipWaitlist = process.env.SKIP_WAITLIST_CHECK === 'true';
    let waitlistEntry = null;
    let stripe_customer_id = undefined;
    let companyNameFromWaitlist = undefined;
    let useCaseCategoriesFromWaitlist = undefined;
    let displayNameFromWaitlist = undefined;

    if (!finalRoles.includes('free')) {
      // Look up waitlist entry to copy bonus data if present (no gate)
      waitlistEntry = await waitlistDb.getByEmail(email);

      if (waitlistEntry) {
        stripe_customer_id = waitlistEntry.stripe_customer_id;
        companyNameFromWaitlist = waitlistEntry.companyName;
        useCaseCategoriesFromWaitlist = waitlistEntry.useCaseCategories;
        displayNameFromWaitlist = waitlistEntry.fullName;
      }
    }

    // If waitlist entry exists and status is invited
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    const finalDisplayName =
      reqDisplayName || displayNameFromWaitlist || email.split("@")[0];

    // Compute attribution up-front so createUser can thread it through the
    // onUserSignup hook → signupAutoEnrollService → lead.customFields. If we
    // compute after createUser like before, the signup hook fires BEFORE
    // attribution is known and the enrolled lead is missing UTM data.
    const touch = normalizeAttribution(attribution) ?? normalizeAttribution(utm);

    const newUser = await userDb.createUser(
      email,
      userId,
      hashedPassword,
      false, // isOAuthUser
      false, // isAdmin (default, adjust if admin status can come from waitlist/req)
      finalRoles,
      finalDisplayName,
      undefined, // googleId
      stripe_customer_id, // from waitlist
      companyNameFromWaitlist, // from waitlist
      useCaseCategoriesFromWaitlist, // from waitlist
      touch // attribution — passes through onUserSignup hook
    );

    // Set Free tier defaults for new registrations (subscription upgrades happen via Stripe checkout)
    const freeTierConfig = await getTierConfig("Free");
    await userDb.updateUser(userId, {
      subscriptionType: "Free",
      allowedPages: freeTierConfig?.allowedPages ?? [...DEFAULT_PAGES],
      allowedSkills: freeTierConfig?.allowedSkills ?? [],
      ...(touch && {
        firstTouch: touch,
        lastTouch: touch,
        ...(touch.utm?.source && { utmSource: touch.utm.source }),
        ...(touch.utm?.medium && { utmMedium: touch.utm.medium }),
      }),
    });

    // If a pending org invite exists for this email, stamp it on the new user so
    // ProtectedRoute redirects them to accept-invite instead of onboarding.
    try {
      const pendingOrg = await orgDb.getOrgWithPendingInviteForEmail(email);
      if (pendingOrg) {
        const invite = pendingOrg.pendingInvites!.find((inv) => inv.email === email.toLowerCase())!;
        await userDb.updateUser(userId, {
          pendingOrgInvite: { orgId: pendingOrg.orgId, inviteToken: invite.inviteToken },
        });
      }
    } catch (err) {
      console.error("Failed to check pending org invite for new user:", err);
      // Non-fatal — user can still accept invite via the link in the email
    }

    // Auto-sync new user to CRM lead list (fire-and-forget)
    syncNewUserToLeadList({
      userId,
      email,
      fullName: finalDisplayName,
      roles: finalRoles,
      isAdmin: false,
      createdAt: new Date().toISOString(),
      stripe_customer_id,
      subscriptionType: "Free",
      attribution: touch,
    }).catch(() => {});

    // Fire user.registered timeline event (fire-and-forget).
    // Distinct from crmSignalHooks.onUserSignup (contact.created + scoring)
    // — this populates the contact activity timeline specifically.
    onUserRegistered({
      userId,
      email,
      displayName: finalDisplayName,
      signupSource: "password",
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    if (process.env.NODE_ENV !== "development") {
      emailService.sendTeamIntroductionEmail(email, finalDisplayName)
        .then(() => userDb.updateUser(userId, { introductionEmailSent: new Date().toISOString() }))
        .catch((err) => console.error("Failed to send team introduction email:", err));
    }

    // JWT includes roles array
    const token = jwt.sign(
      { userId, email, roles: finalRoles, isAdmin: false }, // Include isAdmin=false for clarity
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "90d" }
    );

    res.status(201).json({
      token,
      user: {
        userId,
        email,
        isAdmin: false,
        roles: finalRoles, // Send roles array
        isOAuthUser: false,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error in register:", error);
    res.status(500).json({ message: "Error creating user" });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    let { email, password, attribution } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }
    email = email.toLowerCase();

    const user = await userDb.getUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        message: "User not found. Please create an account to continue.",
        code: "user_not_found",
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        message: "Account has been deactivated. Please contact support.",
        code: "account_deactivated",
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        message: "Invalid credentials. Please check your email and password.",
        code: "invalid_credentials",
      });
    }

    // A system-generated initial password must not become a long-term password.
    // Once it expires, block login and direct the user to reset their password.
    if (user.mustChangePassword && isInitialPasswordExpired(user.tempPasswordExpires)) {
      return res.status(401).json({
        message:
          "Your temporary password has expired. Please reset your password to continue.",
        code: "temp_password_expired",
      });
    }

    // Update last login time + last-touch attribution (if client sent any)
    try {
      const touch = normalizeAttribution(attribution);
      await userDb.updateUser(user.userId, {
        lastLoginTime: new Date().toISOString(),
        ...(touch && { lastTouch: touch }),
      });
    } catch (updateError) {
      console.error("Error updating last login time:", updateError);
      // Don't fail login if lastLoginTime update fails
    }

    const jwtPayload = {
      userId: user.userId,
      email: user.email,
      roles: user.roles || [],
      isAdmin: user.isAdmin || false,
    };
    const token = jwt.sign(
      jwtPayload,
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "90d" }
    );

    const { password: _, ...userWithoutPassword } = user;
    res.json({ token, user: { ...userWithoutPassword, hasBrandGuidelines: !!(user.brandGuidelines?.brandData?.brandName) } });
  } catch (error) {
    console.error("Error in login:", error);
    res.status(500).json({ message: "Error logging in", code: "server_error" });
  }
};

export const googleCallback = async (
  req: Request,
  accessToken: string,
  refreshToken: string,
  profile: Profile,
  done: (error: any, user?: any, info?: any) => void
) => {
  try {
    if (!profile) {
      return done(new Error("Google profile was not received"), null);
    }

    let email =
      profile.emails && profile.emails[0] ? profile.emails[0].value : null;

    if (!email) {
      return done(
        new Error(
          "No email found in Google profile. Please ensure your Google account has a primary email and permissions are granted."
        ),
        null
      );
    }
    email = email.toLowerCase();

    let user = await userDb.getUserByEmail(email);

    const portalOrigin = (req.query.state as string) || "partner";

    // Block new registrations from personal email domains on the customer portal.
    // Existing users are allowed through regardless of domain.
    if (!user && portalOrigin === "customer" && !isCompanyEmail(email)) {
      return done({
        statusCode: 400,
        message: "Please use a company email address to sign up.",
        code: "personal_email_not_allowed",
      }, null);
    }

    if (!user) {
      if (portalOrigin === "genius") {
        // For genius portal, automatically create user using existing signup logic
        const userId = uuidv4();
        const placeholderPassword = `oauth_placeholder_${uuidv4()}`;
        const finalDisplayName = profile.displayName || email.split("@")[0];
        const roles: ("partner" | "customer" | "free")[] = ["free"];

        // Reuse existing user creation logic (same as waitlist flow)
        user = await userDb.createUser(
          email,
          userId,
          placeholderPassword,
          true, // isOAuthUser
          false, // isAdmin
          roles,
          finalDisplayName,
          profile.id, // googleId
          undefined, // No stripe_customer_id for direct signup
          undefined, // No companyNameFromWaitlist for direct signup
          undefined  // No useCaseCategoriesFromWaitlist for direct signup
        );
        console.log("New user created via Google OAuth (auto-signup):", user?.email);

        if (!user) {
          console.error(
            "Failed to create user via Google OAuth for email:",
            email
          );
          return done(
            new Error("User creation failed after Google OAuth process."),
            null
          );
        }

        // Set Free tier defaults for OAuth registrations
        const freeTierConfig = await getTierConfig("Free");
        await userDb.updateUser(user.userId, {
          subscriptionType: "Free",
          allowedPages: freeTierConfig?.allowedPages ?? [...DEFAULT_PAGES],
          allowedSkills: freeTierConfig?.allowedSkills ?? [],
          signupSource: "oauth",
        });

        // Auto-sync new user to CRM lead list (fire-and-forget)
        syncNewUserToLeadList({
          userId: user.userId,
          email,
          fullName: finalDisplayName,
          roles,
          isAdmin: false,
          subscriptionType: "Free",
        }).catch(() => {});

        if (process.env.NODE_ENV !== "development") {
          emailService.sendTeamIntroductionEmail(email, finalDisplayName)
            .then(() => userDb.updateUser(user!.userId, { introductionEmailSent: new Date().toISOString() }))
            .catch((err) => console.error("Failed to send team introduction email:", err));
        }
      } else {
        // For other portals, look up waitlist for bonus data (no gate)
        const waitlistEntry = await waitlistDb.getByEmail(email);

        const userId = uuidv4();
        const placeholderPassword = `oauth_placeholder_${uuidv4()}`;

        const stripe_customer_id = waitlistEntry?.stripe_customer_id;
        const companyNameFromWaitlist = waitlistEntry?.companyName;
        const useCaseCategoriesFromWaitlist = waitlistEntry?.useCaseCategories;
        const finalDisplayName =
          profile.displayName || waitlistEntry?.fullName || email.split("@")[0];

        const roles: ("partner" | "customer" | "free")[] =
          portalOrigin === "customer" ? ["customer"] : ["free"];

        user = await userDb.createUser(
          email,
          userId,
          placeholderPassword,
          true,
          false,
          roles,
          finalDisplayName,
          profile.id,
          stripe_customer_id,
          companyNameFromWaitlist,
          useCaseCategoriesFromWaitlist
        );
        console.log("New user created via Google OAuth:", user?.email);

        if (!user) {
          console.error(
            "Failed to create user via Google OAuth for email:",
            email
          );
          return done(
            new Error("User creation failed after Google OAuth process."),
            null
          );
        }

        // Set Free tier defaults for OAuth registrations
        const freeTierConfigOAuth = await getTierConfig("Free");
        await userDb.updateUser(user.userId, {
          subscriptionType: "Free",
          allowedPages: freeTierConfigOAuth?.allowedPages ?? [...DEFAULT_PAGES],
          allowedSkills: freeTierConfigOAuth?.allowedSkills ?? [],
          signupSource: "oauth",
        });

        // Auto-sync new user to CRM lead list (fire-and-forget)
        syncNewUserToLeadList({
          userId: user.userId,
          email,
          fullName: finalDisplayName,
          roles,
          isAdmin: false,
          stripe_customer_id,
          subscriptionType: "Free",
        }).catch(() => {});

        if (process.env.NODE_ENV !== "development") {
          emailService.sendTeamIntroductionEmail(email, finalDisplayName)
            .then(() => userDb.updateUser(user!.userId, { introductionEmailSent: new Date().toISOString() }))
            .catch((err) => console.error("Failed to send team introduction email:", err));
        }
      }
    }

    // For newly created users: check if a pending org invite exists for this email
    // and stamp it so ProtectedRoute redirects them to accept-invite instead of onboarding.
    if (user && !user.orgId && !user.pendingOrgInvite) {
      try {
        const pendingOrg = await orgDb.getOrgWithPendingInviteForEmail(email);
        if (pendingOrg) {
          const invite = pendingOrg.pendingInvites!.find((inv) => inv.email === email.toLowerCase())!;
          await userDb.updateUser(user.userId, {
            pendingOrgInvite: { orgId: pendingOrg.orgId, inviteToken: invite.inviteToken },
          });
          user.pendingOrgInvite = { orgId: pendingOrg.orgId, inviteToken: invite.inviteToken };
        }
      } catch (err) {
        console.error("Failed to check pending org invite for new OAuth user:", err);
      }
    }

    // If user already exists, check if they have an invited waitlist entry
    // and add customer role if they don't have it yet
    if (user) {
      const waitlistEntry = await waitlistDb.getByEmail(email);
      if (
        waitlistEntry &&
        waitlistEntry.status === "invited" &&
        (!user.roles || !user.roles.includes("customer"))
      ) {
        // User was invited but doesn't have customer role yet - add it
        // Also copy stripe_customer_id from waitlist if user doesn't have one
        const updatedRoles = user.roles && user.roles.length > 0
          ? [...user.roles, "customer"]
          : ["customer"];
        const updatePayload: any = { roles: updatedRoles };
        if (waitlistEntry.stripe_customer_id && !user.stripe_customer_id) {
          updatePayload.stripe_customer_id = waitlistEntry.stripe_customer_id;
          user.stripe_customer_id = waitlistEntry.stripe_customer_id;
        }
        await userDb.updateUser(user.userId, updatePayload);
        user.roles = updatedRoles;
        console.log(`Added customer role to existing user ${email} during OAuth login`);
      }
    }

    if (
      portalOrigin === "customer" &&
      (!user.roles || !user.roles.includes("customer"))
    ) {
      const errorObj = {
        statusCode: 403,
        message:
          "Access denied: Your account does not have permission to access this customer portal.",
        code: "invalid_role",
      };
      return done(errorObj, null);
    }

    // For genius portal, assign free role to prevent access to customer portal
    if (
      portalOrigin === "genius" &&
      (!user.roles || (user.roles.length === 0))
    ) {
      // If user has no roles, assign free role by default
      await userDb.updateUser(user.userId, {
        roles: ["free"]
      });
      user.roles = ["free"];
    }

    // Update last login time for OAuth login
    try {
      await userDb.updateUser(user.userId, {
        lastLoginTime: new Date().toISOString()
      });
    } catch (updateError) {
      console.error("Error updating last login time for OAuth user:", updateError);
      // Don't fail login if lastLoginTime update fails
    }

    const userRoles =
      user.roles && user.roles.length > 0
        ? user.roles
        : portalOrigin === "customer"
        ? ["customer"]
        : portalOrigin === "genius"
        ? ["free"] // Default to free for genius portal
        : ["partner"];

    const tokenPayload = {
      userId: user.userId,
      email: user.email,
      roles: userRoles,
      isAdmin: user.isAdmin || false,
    };
    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET || "your-secret-key",
      { expiresIn: "90d" }
    );

    const resultUserObject = {
      token,
      userId: user.userId,
      email: user.email,
      roles: userRoles,
      isAdmin: user.isAdmin || false,
    };
    done(null, resultUserObject);
  } catch (error: any) {
    let formattedError = error;
    if (error instanceof Error) {
      formattedError = {
        statusCode: 500,
        message:
          error.message ||
          "An unexpected error occurred during Google authentication.",
        code: "server_error",
      };
    }
    done(formattedError, null);
  }
};

// Password reset request
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await userDb.getUserByEmail(email.toLowerCase());
    if (!user) {
      // Don't reveal if user exists or not for security
      return res.json({ 
        message: "If an account with that email exists, we've sent a password reset link." 
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    // Update user with reset token
    await userDb.updateUser(user.userId, {
      resetPasswordToken: resetToken,
      resetPasswordExpires: resetTokenExpiry.toISOString()
    });

    // Send reset email
    const resetUrl = `${process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174'}/reset-password?token=${resetToken}`;
    
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
          <p style="color: #666; margin: 5px 0;">Customer Portal</p>
        </div>
        
        <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1B2549; margin-top: 0;">Password Reset Request</h2>
          <p style="color: #333; line-height: 1.6;">
            You requested a password reset for your AgentWeb account. Click the button below to reset your password:
          </p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); 
                      color: white; 
                      padding: 12px 30px; 
                      text-decoration: none; 
                      border-radius: 6px; 
                      display: inline-block;
                      font-weight: bold;">
              Reset Password
            </a>
          </div>
          
          <p style="color: #666; font-size: 14px; margin-top: 20px;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${resetUrl}" style="color: #643B7E; word-break: break-all;">${resetUrl}</a>
          </p>
        </div>
        
        <div style="text-align: center; color: #666; font-size: 12px;">
          <p>This link will expire in 1 hour for security reasons.</p>
          <p>If you didn't request this password reset, please ignore this email.</p>
        </div>
      </div>
    `;

    const emailText = `
AgentWeb Customer Portal - Password Reset Request

You requested a password reset for your AgentWeb account.

To reset your password, visit: ${resetUrl}

This link will expire in 1 hour for security reasons.

If you didn't request this password reset, please ignore this email.

Best regards,
The AgentWeb Team
    `;

    await emailService.sendEmail(
      email,
      'Reset Your AgentWeb Password',
      emailText,
      emailHtml
    );

    res.json({ 
      message: "If an account with that email exists, we've sent a password reset link." 
    });
  } catch (error) {
    console.error("Error in forgot password:", error);
    res.status(500).json({ message: "Error processing password reset request" });
  }
};

// Password reset with token
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: "Token and password are required" });
    }

    if (password.length < 12) {
      return res.status(400).json({ message: "Password must be at least 12 characters long" });
    }

    // Find user by reset token
    const user = await userDb.getUserByResetToken(token);
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    // Check if token is expired
    if (user.resetPasswordExpires && new Date(user.resetPasswordExpires) < new Date()) {
      return res.status(400).json({ message: "Reset token has expired" });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Update user password and clear reset token. Also clear the initial /
    // temporary password lifecycle fields — the user has now set their own
    // long-term password.
    await userDb.updateUser(user.userId, {
      password: hashedPassword,
      resetPasswordToken: undefined,
      resetPasswordExpires: undefined,
      mustChangePassword: false,
      // null (not undefined) — updateUser skips undefined, so a stale expiry
      // timestamp would otherwise linger on the record.
      tempPasswordExpires: null
    });

    res.json({ message: "Password has been reset successfully" });
  } catch (error) {
    console.error("Error in reset password:", error);
    res.status(500).json({ message: "Error resetting password" });
  }
};

// Authenticated self-service password change (Settings → Change Password, and
// the forced-change screen for temp-password users). This is the in-app path
// for converting a system-generated initial password into the user's own
// long-term password, so it MUST clear the temporary password lifecycle flags.
export const changePassword = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ message: "Current and new passwords are required" });
    }

    if (newPassword.length < 12) {
      return res
        .status(400)
        .json({ message: "New password must be at least 12 characters long" });
    }

    if (newPassword === currentPassword) {
      return res
        .status(400)
        .json({ message: "New password must be different from current password" });
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // OAuth accounts have no real password to verify against.
    if (user.isOAuthUser || user.googleId) {
      return res.status(400).json({
        message: "Password change is not available for accounts that sign in with Google.",
      });
    }

    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Set the new long-term password and clear the temporary-password lifecycle
    // flags — the initial secret can no longer become the long-term password
    // once the user has chosen their own.
    await userDb.updateUser(userId, {
      password: hashedPassword,
      mustChangePassword: false,
      // null (not undefined) — updateUser skips undefined values.
      tempPasswordExpires: null,
    });

    res.json({ message: "Password has been changed successfully" });
  } catch (error) {
    console.error("Error in change password:", error);
    res.status(500).json({ message: "Error changing password" });
  }
};
