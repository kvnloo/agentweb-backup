import express, { Request, Response } from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { waitlistDb, WaitlistEntry } from "../services/waitlistDb"; // Import waitlistDb and WaitlistEntry
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth"; // Added AuthenticatedRequest and authenticateToken
import { userDb, User } from "../services/db"; // Added userDb and User

dotenv.config();

const router = express.Router();

// Ensure STRIPE_SECRET_KEY is set in your .env file
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const CUSTOMER_FRONTEND_URL =
  process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174"; // For return URL

if (!stripeSecretKey) {
  console.error(
    "Stripe secret key (STRIPE_SECRET_KEY) is not set in the environment variables."
  );
  // Optionally, you could throw an error here to prevent the app from starting
  // or handle it in a way that doesn't expose uninitialized Stripe functionality.
}

// Initialize Stripe with a check for the key
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: "2025-05-28.basil", // Using the version suggested by the linter
    })
  : null;

/**
 * @route GET /api/stripe/session/:sessionId
 * @desc Get customer email from Stripe Checkout session
 * @access Public (consider adding authentication if needed)
 */
router.get("/session/:sessionId", async (req: Request, res: Response) => {
  if (!stripe) {
    console.error("Stripe SDK not initialized. Missing STRIPE_SECRET_KEY.");
    return res
      .status(500)
      .json({ error: "Stripe integration is not configured correctly." });
  }

  const { sessionId } = req.params;

  if (!sessionId?.startsWith("cs_")) {
    return res
      .status(400)
      .json({ error: "Invalid Stripe Checkout Session ID format." });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer", "payment_intent.customer", "setup_intent.customer"],
    });

    // Log the entire session object to inspect its structure, including custom fields/metadata
    console.log(
      "Full Stripe Session Object for ID",
      sessionId,
      ":",
      JSON.stringify(session, null, 2)
    );

    let email: string | null = null;
    let fullName: string | undefined = undefined;
    let phoneNumber: string | undefined = undefined;
    let stripeCustomerIdFromSession: string | undefined = undefined;
    let companyNameFromCustomFields: string | undefined = undefined;
    let productUsageValueFromStripe: string | undefined = undefined;
    let productUsageLabelFromStripe: string | undefined = undefined;

    // Extract custom fields
    if (session.custom_fields && Array.isArray(session.custom_fields)) {
      for (const field of session.custom_fields) {
        if (
          field.key === "companyname" &&
          field.text &&
          typeof field.text.value === "string"
        ) {
          companyNameFromCustomFields = field.text.value;
        }
        if (
          field.key === "howdoyouplantousethisproduct" &&
          field.dropdown &&
          typeof field.dropdown.value === "string"
        ) {
          const selectedValue = field.dropdown.value;
          productUsageValueFromStripe = selectedValue;
          const selectedOption = field.dropdown.options?.find(
            (opt) => opt.value === selectedValue
          );
          if (selectedOption && typeof selectedOption.label === "string") {
            productUsageLabelFromStripe = selectedOption.label;
          } else {
            productUsageLabelFromStripe = selectedValue;
            console.warn(
              `Stripe session ${sessionId}: Label not found for product usage value '${selectedValue}'. Using value instead.`
            );
          }
        }
      }
    }

    if (session.customer) {
      if (typeof session.customer === "string") {
        stripeCustomerIdFromSession = session.customer;
      } else if (session.customer.id && !session.customer.deleted) {
        stripeCustomerIdFromSession = session.customer.id;
      }
    }

    // Extract email from various possible locations in the session object
    if (
      session.customer &&
      typeof session.customer === "object" &&
      !session.customer.deleted &&
      session.customer.email
    ) {
      email = session.customer.email;
      fullName = session.customer.name || undefined;
      phoneNumber = session.customer.phone || undefined;
    } else if (session.customer_details && session.customer_details.email) {
      email = session.customer_details.email;
      fullName = session.customer_details.name || undefined;
      phoneNumber = session.customer_details.phone || undefined;
    } else if (
      session.payment_intent &&
      typeof session.payment_intent === "object" &&
      session.payment_intent.customer &&
      typeof session.payment_intent.customer === "object" &&
      !session.payment_intent.customer.deleted &&
      session.payment_intent.customer.email
    ) {
      email = session.payment_intent.customer.email;
      fullName = session.payment_intent.customer.name || undefined;
      phoneNumber = session.payment_intent.customer.phone || undefined;
    } else if (
      session.setup_intent &&
      typeof session.setup_intent === "object" &&
      session.setup_intent.customer &&
      typeof session.setup_intent.customer === "object" &&
      !session.setup_intent.customer.deleted &&
      session.setup_intent.customer.email
    ) {
      email = session.setup_intent.customer.email;
      fullName = session.setup_intent.customer.name || undefined;
      phoneNumber = session.setup_intent.customer.phone || undefined;
    }

    if (email) {
      email = email.toLowerCase(); // Normalize email
      const existingUser = await userDb.getUserByEmail(email);

      if (existingUser && existingUser.userId) {
        console.log(
          `Stripe session email ${email} matches existing user ${existingUser.userId}.`
        );

        const userUpdates: Partial<User> = {}; // CORRECTED TYPE USAGE
        let needsUserUpdate = false;

        if (
          stripeCustomerIdFromSession &&
          existingUser.stripe_customer_id !== stripeCustomerIdFromSession
        ) {
          userUpdates.stripe_customer_id = stripeCustomerIdFromSession;
          needsUserUpdate = true;
        }
        if (
          companyNameFromCustomFields &&
          existingUser.companyName !== companyNameFromCustomFields
        ) {
          userUpdates.companyName = companyNameFromCustomFields;
          needsUserUpdate = true;
        }
        if (
          productUsageLabelFromStripe &&
          (!existingUser.useCaseCategories ||
            existingUser.useCaseCategories.length !== 1 ||
            existingUser.useCaseCategories[0] !== productUsageLabelFromStripe)
        ) {
          userUpdates.useCaseCategories = [productUsageLabelFromStripe];
          needsUserUpdate = true;
        }

        if (needsUserUpdate) {
          try {
            await userDb.updateUser(existingUser.userId, userUpdates);
            console.log(
              `Updated existing user ${existingUser.userId} with new details:`,
              userUpdates
            );
          } catch (userUpdateError) {
            console.error(
              `Failed to update details for existing user ${existingUser.userId}:`,
              userUpdateError
            );
          }
        }

        // Also update waitlist entry for consistency if user exists
        const waitlistUpdatesForUser: Partial<WaitlistEntry> = {}; // CORRECTED TYPE USAGE
        let needsWaitlistUpdateForUser = false;

        if (stripeCustomerIdFromSession) {
          waitlistUpdatesForUser.stripe_customer_id =
            stripeCustomerIdFromSession;
          needsWaitlistUpdateForUser = true; // Assume update if ID is present, updateDetails will check if different
        }
        if (companyNameFromCustomFields) {
          waitlistUpdatesForUser.companyName = companyNameFromCustomFields;
          needsWaitlistUpdateForUser = true;
        }
        if (productUsageLabelFromStripe) {
          waitlistUpdatesForUser.useCaseCategories = [
            productUsageLabelFromStripe,
          ];
          needsWaitlistUpdateForUser = true;
        }

        if (needsWaitlistUpdateForUser) {
          try {
            const waitlistEntryForUser = await waitlistDb.getByEmail(email);
            if (waitlistEntryForUser) {
              // Check if actual changes are needed before calling update
              const currentWaitlist = waitlistEntryForUser;
              const changesExist = Object.keys(waitlistUpdatesForUser).some(
                (key) =>
                  waitlistUpdatesForUser[
                    key as keyof typeof waitlistUpdatesForUser
                  ] !== currentWaitlist[key as keyof typeof currentWaitlist]
              );
              if (changesExist) {
                await waitlistDb.updateDetails(email, waitlistUpdatesForUser);
                console.log(
                  `Updated waitlist entry for user ${email} with new details:`,
                  waitlistUpdatesForUser
                );
              }
            } else {
              console.log(
                `User ${email} exists but no corresponding waitlist entry found to update details.`
              );
            }
          } catch (waitlistUpdateError) {
            console.error(
              `Failed to update details for waitlist entry of user ${email}:`,
              waitlistUpdateError
            );
          }
        }

        return res.json({
          email,
          existingUser: true,
          stripe_customer_id:
            stripeCustomerIdFromSession || existingUser.stripe_customer_id,
          companyName: companyNameFromCustomFields || existingUser.companyName,
          useCaseCategories: productUsageLabelFromStripe
            ? [productUsageLabelFromStripe]
            : existingUser.useCaseCategories,
        });
      } else {
        // No existing user, proceed with waitlist logic
        console.log(
          `Stripe session email ${email} does not match an existing user. Proceeding with waitlist logic.`
        );
        const existingWaitlistEntry = await waitlistDb.getByEmail(email);
        const waitlistDataForUpsert: any = {
          email: email,
          fullName: fullName,
          phoneNumber: phoneNumber,
          companyName:
            companyNameFromCustomFields || existingWaitlistEntry?.companyName, // Prioritize new, then existing, then default
          supportNote:
            existingWaitlistEntry?.supportNote || "Joined/Updated from Stripe",
          joinedAt: existingWaitlistEntry?.joinedAt || new Date().toISOString(),
          status: "invited", // Always ensure status is invited
          invitedAt: new Date().toISOString(),
          stripe_customer_id: stripeCustomerIdFromSession, // Add stripe_customer_id
          useCaseCategories: productUsageLabelFromStripe
            ? [productUsageLabelFromStripe]
            : existingWaitlistEntry?.useCaseCategories || [], // Map to array
        };
        // Default companyName if still undefined
        if (waitlistDataForUpsert.companyName === undefined) {
          waitlistDataForUpsert.companyName = "Freelancer"; // Default if nothing else provided
        }

        if (existingWaitlistEntry) {
          console.log(`Updating existing waitlist entry for ${email}.`);
          await waitlistDb.updateDetails(email, waitlistDataForUpsert);
        } else {
          console.log(`Creating new waitlist entry for ${email}.`);
          await waitlistDb.add(waitlistDataForUpsert); // add handles the toLowerCase for email internally
        }
        return res.json({
          email,
          existingUser: false,
          stripe_customer_id: stripeCustomerIdFromSession,
          companyName: companyNameFromCustomFields,
          useCaseCategories: productUsageLabelFromStripe
            ? [productUsageLabelFromStripe]
            : [],
        });
      }
    } else {
      console.warn(
        `Email not found for session ID: ${sessionId}. Relevant session fields:`,
        {
          customer_id: stripeCustomerIdFromSession, // Log the extracted ID
          customer_details_email: session.customer_details?.email,
          payment_intent_id: session.payment_intent
            ? typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent.id
            : null,
          setup_intent_id: session.setup_intent
            ? typeof session.setup_intent === "string"
              ? session.setup_intent
              : session.setup_intent.id
            : null,
        }
      );
      return res.status(404).json({
        error:
          "Email not found for this session. The session may not have an associated email or customer.",
      });
    }
  } catch (error: any) {
    console.error("Stripe API error while retrieving session:", error.message);
    if (
      error.type === "StripeInvalidRequestError" &&
      error.code === "resource_missing"
    ) {
      return res.status(404).json({ error: "Stripe session not found." });
    } else {
      return res
        .status(500)
        .json({ error: "Failed to retrieve session details from Stripe." });
    }
  }
});

/**
 * @route POST /api/stripe/create-customer-portal-session
 * @desc Create a Stripe Customer Portal session for the authenticated user
 * @access Private (requires authentication)
 */
router.post(
  "/create-customer-portal-session",
  authenticateToken,
  async (req: Request, res: Response) => {
    if (!stripe) {
      console.error("Stripe SDK not initialized. Missing STRIPE_SECRET_KEY.");
      return res
        .status(500)
        .json({ error: "Stripe integration is not configured correctly." });
    }

    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated." });
    }

    try {
      const user = await userDb.getUserById(userId);
      if (!user || !user.stripe_customer_id) {
        console.error(`User ${userId} does not have a Stripe customer ID.`);
        return res.status(404).json({
          message:
            "Stripe customer ID not found for this user. Cannot open portal.",
        });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${CUSTOMER_FRONTEND_URL}/settings`, // Or any other relevant page
      });

      res.json({ url: portalSession.url });
    } catch (error: any) {
      console.error(
        "Error creating Stripe Customer Portal session:",
        error.message
      );
      res.status(500).json({
        error: "Failed to create Stripe Customer Portal session.",
        details: error.message,
      });
    }
  }
);

export default router;
