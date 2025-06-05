import express, { Request, Response } from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import { waitlistDb } from "../services/waitlistDb"; // Import waitlistDb
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth"; // Added AuthenticatedRequest and authenticateToken
import { userDb } from "../services/db"; // Added userDb

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
    // Retrieve the session with expanded customer information
    // Also expanding payment_intent.customer for cases where customer might be attached there
    // and setup_intent.customer for subscription setups
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer", "payment_intent.customer", "setup_intent.customer"],
    });

    let email: string | null = null;
    let fullName: string | undefined = undefined;
    let phoneNumber: string | undefined = undefined;

    // 1. Check customer object directly attached to the session
    if (
      session.customer &&
      typeof session.customer === "object" &&
      !session.customer.deleted &&
      session.customer.email
    ) {
      email = session.customer.email;
      fullName = session.customer.name || undefined; // Get name from customer object
      phoneNumber = session.customer.phone || undefined; // Get phone from customer object
    }
    // 2. Check customer_details (often used for guest checkouts)
    else if (session.customer_details && session.customer_details.email) {
      email = session.customer_details.email;
      fullName = session.customer_details.name || undefined; // Get name from customer_details
      phoneNumber = session.customer_details.phone || undefined; // Get phone from customer_details
    }
    // 3. Check customer object on the PaymentIntent (if it exists)
    else if (
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
    }
    // 4. Check customer object on the SetupIntent (if it exists, e.g., for subscriptions)
    else if (
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
      // Attempt to add to waitlist before sending response
      try {
        const waitlistEntry = {
          email: email,
          fullName: fullName,
          phoneNumber: phoneNumber,
          companyName: "Freelancer", // As requested
          supportNote: "Joined directly from Stripe", // As requested
          joinedAt: new Date().toISOString(),
          // status will default to 'pending' in waitlistDb.add
        };
        await waitlistDb.add(waitlistEntry);
        console.log(
          `Successfully added ${email} to waitlist from Stripe session.`
        );
        // After adding, immediately update status to invited
        try {
          await waitlistDb.updateStatus(
            email,
            "invited",
            new Date().toISOString()
          );
          console.log(
            `Successfully updated ${email} status to 'invited' in waitlist.`
          );
        } catch (updateError: any) {
          console.error(
            `Failed to update status to 'invited' for ${email}:`,
            updateError.message
          );
          // Continue even if status update fails, primary goal is email pre-fill
        }
      } catch (waitlistError: any) {
        if (waitlistError.code === "ConditionalCheckFailedException") {
          console.log(
            `User ${email} from Stripe session is already on the waitlist.`
          );
          // If user already exists, still try to update their status to invited
          try {
            // Check current status first to avoid unnecessary updates if already invited or beyond
            const existingEntry = await waitlistDb.getByEmail(email);
            if (
              existingEntry &&
              existingEntry.status !== "invited" &&
              existingEntry.status !== "onboarded"
            ) {
              // Example: don't downgrade if already 'onboarded'
              await waitlistDb.updateStatus(
                email,
                "invited",
                new Date().toISOString()
              );
              console.log(
                `Successfully updated existing user ${email} status to 'invited' in waitlist.`
              );
            } else if (existingEntry) {
              console.log(
                `User ${email} status is already '${existingEntry.status}', no update needed or appropriate.`
              );
            }
          } catch (updateError: any) {
            console.error(
              `Failed to update status to 'invited' for existing user ${email}:`,
              updateError.message
            );
          }
        } else {
          console.error(
            "Failed to add user to waitlist from Stripe session:",
            waitlistError.message
          );
        }
      }

      res.json({ email });
    } else {
      console.warn(
        `Email not found for session ID: ${sessionId}. Relevant session fields:`,
        {
          customer_id: session.customer
            ? typeof session.customer === "string"
              ? session.customer
              : !session.customer.deleted
              ? session.customer.id
              : "deleted"
            : null,
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
      res.status(404).json({
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
      res.status(404).json({ error: "Stripe session not found." });
    } else {
      res
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
      // --- Placeholder for fetching Stripe Customer ID ---
      // TODO: Replace this with actual logic to get stripeCustomerId from your userDb
      // For example, if you add 'stripeCustomerId' to your User model:
      const user = await userDb.getUserById(userId);
      const stripeCustomerId = user?.stripeCustomerId; // Assuming user object has stripeCustomerId
      // --- End Placeholder ---

      if (!stripeCustomerId) {
        console.error(`Stripe Customer ID not found for user ${userId}.`);
        return res.status(404).json({
          message:
            "Stripe customer ID not found for this user. Unable to create portal session.",
        });
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: `${CUSTOMER_FRONTEND_URL}/dashboard`, // Or any other appropriate return URL
      });

      res.json({ url: portalSession.url });
    } catch (error: any) {
      console.error(
        "Error creating Stripe Customer Portal session:",
        error.message
      );
      res.status(500).json({
        message: "Failed to create Stripe Customer Portal session.",
        error: error.message,
      });
    }
  }
);

export default router;
