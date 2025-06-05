import express, { Request, Response } from "express";
import Stripe from "stripe";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();

// Ensure STRIPE_SECRET_KEY is set in your .env file
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

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

    // 1. Check customer object directly attached to the session
    if (
      session.customer &&
      typeof session.customer === "object" &&
      !session.customer.deleted &&
      session.customer.email
    ) {
      email = session.customer.email;
    }
    // 2. Check customer_details (often used for guest checkouts)
    else if (session.customer_details && session.customer_details.email) {
      email = session.customer_details.email;
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
    }

    if (email) {
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

export default router;
