import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userDb } from "../services/db";
import { Profile } from "passport-google-oauth20";
import { waitlistDb } from "../services/waitlistDb";
import { v4 as uuidv4 } from "uuid";

export const register = async (req: Request, res: Response) => {
  try {
    let {
      email,
      password,
      roles: reqRoles,
      displayName: reqDisplayName,
    } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }
    email = email.toLowerCase();

    // Check if user exists
    const existingUser = await userDb.getUserByEmail(email);
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Check waitlist status
    const waitlistEntry = await waitlistDb.getByEmail(email);

    if (!waitlistEntry) {
      const landingSiteUrl =
        process.env.LANDING_SITE_URL || "https://agentweb.pro";
      return res.status(403).json({
        message: `Please join our waitlist first at ${landingSiteUrl}`,
        code: "not_in_waitlist",
      });
    }

    if (waitlistEntry.status !== "invited") {
      return res.status(403).json({
        message:
          "Your account is on our waitlist but hasn't been invited yet. Please look out for an invitation email.",
        code: "not_invited",
      });
    }

    // If waitlist entry exists and status is invited
    const userId = uuidv4();
    const hashedPassword = await bcrypt.hash(password, 10);

    // Extract additional details from waitlist entry to pass to createUser
    const stripe_customer_id = waitlistEntry.stripe_customer_id;
    const companyNameFromWaitlist = waitlistEntry.companyName;
    const useCaseCategoriesFromWaitlist = waitlistEntry.useCaseCategories;
    const displayNameFromWaitlist = waitlistEntry.fullName; // Assuming fullName from waitlist is a good default for displayName

    // Determine roles: use reqRoles if provided, otherwise default to ["customer"]
    // This also depends on your logic for how partner roles are assigned, adjust if necessary
    const finalRoles =
      reqRoles && Array.isArray(reqRoles) && reqRoles.length > 0
        ? reqRoles
        : ["customer"];

    const finalDisplayName =
      reqDisplayName || displayNameFromWaitlist || email.split("@")[0];

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
      useCaseCategoriesFromWaitlist // from waitlist
    );

    // JWT includes roles array
    const token = jwt.sign(
      { userId, email, roles: finalRoles, isAdmin: false }, // Include isAdmin=false for clarity
      process.env.JWT_SECRET || "your-secret-key"
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
    let { email, password } = req.body;

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

    // Update last login time
    try {
      await userDb.updateUser(user.userId, {
        lastLoginTime: new Date().toISOString()
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
      process.env.JWT_SECRET || "your-secret-key"
    );

    const { password: _, ...userWithoutPassword } = user;
    res.json({ token, user: userWithoutPassword });
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

    if (!user) {
      const waitlistEntry = await waitlistDb.getByEmail(email);

      if (!waitlistEntry) {
        const landingSiteUrl =
          process.env.LANDING_SITE_URL || "https://agentweb.pro";
        return done(null, false, {
          message: `Please join our waitlist first at ${landingSiteUrl}`,
          code: "not_in_waitlist",
        });
      }

      if (waitlistEntry.status !== "invited") {
        return done(null, false, {
          message: "You are on the waitlist but not yet invited.",
          code: "not_invited",
        });
      }

      const userId = uuidv4();
      const placeholderPassword = `oauth_placeholder_${uuidv4()}`;

      const stripe_customer_id = waitlistEntry.stripe_customer_id;
      const companyNameFromWaitlist = waitlistEntry.companyName;
      const useCaseCategoriesFromWaitlist = waitlistEntry.useCaseCategories;
      const finalDisplayName =
        profile.displayName || waitlistEntry.fullName || email.split("@")[0];

      const roles: ("partner" | "customer" | "free")[] = ["free"];

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
      process.env.JWT_SECRET || "your-secret-key"
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
