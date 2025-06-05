import { Request, Response } from "express";
import Stripe from "stripe";
import { userDb } from "../services/db"; // Assuming userDb is accessible
import dotenv from "dotenv";

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2025-05-28.basil", // Use your Stripe API version
});

const relevantEvents = new Set([
  "checkout.session.completed",
  // Potentially: 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'
  // if you want to handle more direct subscription changes.
]);

export const handleStripeWebhook = async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("Stripe webhook secret is not set.");
    return res.status(400).send("Webhook Error: Missing webhook secret");
  }

  let event: Stripe.Event;

  try {
    // Use req.rawBody if you've set up middleware to attach it, otherwise req.body
    // Ensure that your Express app uses express.raw({type: 'application/json'}) for this route
    const requestBody = req.body; // This assumes express.raw has populated req.body correctly for Buffers
    event = stripe.webhooks.constructEvent(requestBody, sig, webhookSecret);
  } catch (err: any) {
    console.error(`Error verifying Stripe webhook signature: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (relevantEvents.has(event.type)) {
    try {
      switch (event.type) {
        case "checkout.session.completed":
          const session = event.data.object as Stripe.Checkout.Session;

          const stripeCustomerId = session.customer as string;
          const clientReferenceId = session.client_reference_id; // This should be your internal userId or email
          const customerEmailFromSession = session.customer_details?.email;

          if (!stripeCustomerId) {
            console.warn(
              "Webhook received checkout.session.completed without a customer ID.",
              session.id
            );
            // Potentially email was collected and customer object was not created by Stripe yet.
            // Or this payment was not for a Stripe customer.
            return res
              .status(200)
              .send("Session did not create a Stripe customer.");
          }

          let userToUpdate;

          // Priority 1: Use client_reference_id if it's likely a user_id
          // (You might need a regex or format check to distinguish user_id from email if both can be here)
          if (clientReferenceId) {
            // Assuming clientReferenceId could be userId. If it's email, the next block handles it.
            console.log(
              `Attempting to find user by client_reference_id (assumed userId): ${clientReferenceId}`
            );
            try {
              userToUpdate = await userDb.getUserById(clientReferenceId);
            } catch (e) {
              console.warn(
                `Could not find user by client_reference_id ${clientReferenceId} as userId, will try as email or fallback.`
              );
            }
          }

          // Priority 2: Use email from client_reference_id (if it was set to email) or from customer_details
          if (
            !userToUpdate &&
            clientReferenceId &&
            clientReferenceId.includes("@")
          ) {
            // Check if it looks like an email
            console.log(
              `Attempting to find user by client_reference_id (assumed email): ${clientReferenceId}`
            );
            userToUpdate = await userDb.getUserByEmail(clientReferenceId);
          }

          if (!userToUpdate && customerEmailFromSession) {
            console.log(
              `Attempting to find user by customer_details.email: ${customerEmailFromSession}`
            );
            userToUpdate = await userDb.getUserByEmail(
              customerEmailFromSession
            );
          }

          if (userToUpdate && userToUpdate.userId) {
            console.log(
              `Updating user ${userToUpdate.userId} (${userToUpdate.email}) with stripe_customer_id: ${stripeCustomerId}`
            );
            await userDb.updateUser(userToUpdate.userId, {
              stripe_customer_id: stripeCustomerId,
            });
            console.log(`User ${userToUpdate.userId} updated successfully.`);
          } else {
            console.warn(
              "Webhook handler: User not found with client_reference_id or email from session. Stripe Customer ID:",
              stripeCustomerId
            );
            // Optional: Store this mapping temporarily if user might register later with this email.
            // For now, we just log it.
          }
          break;
        // Add other event types here if needed
        default:
          console.log(`Unhandled relevant event type: ${event.type}`);
      }
    } catch (error) {
      console.error("Error processing webhook event:", error);
      // Do not send 4xx, as Stripe will retry. Send 200 unless it's a permanent error configuration.
      // If it's an error in our logic that can be fixed, let Stripe retry.
      // If it's a bad request from Stripe (e.g. bad signature), it's handled above.
      return res
        .status(500)
        .json({
          error: "Webhook processing failed. Please check server logs.",
        });
    }
  } else {
    console.log(`Received unhandled event type: ${event.type}`);
  }

  res.status(200).json({ received: true });
};
