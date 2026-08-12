import express, { Request, Response } from "express";
import Stripe from "stripe";
import { createStripeClient } from "../services/stripeClientFactory";
import dotenv from "dotenv";
import { waitlistDb, WaitlistEntry } from "../services/waitlistDb"; // Import waitlistDb and WaitlistEntry
import { authenticateToken, requireAdmin, AuthenticatedRequest } from "../middleware/auth";
import { userDb, User } from "../services/db"; // Added userDb and User
import * as stripeController from "../controllers/stripeController";
import { resolveBillingUserId } from '../services/tokenUsageService';
import { getSubscriptionTypeConfig, getUserSubscriptionType } from '../services/subscriptionService';
import { getActiveLlmUsageTopUpPackages, resolveLlmUsageTopUpPackage } from '../services/llmUsageTopUpService';

dotenv.config();

const router = express.Router();

const CUSTOMER_FRONTEND_URL =
  process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174"; // For return URL

// Lazy Stripe client — must be a getter, NOT a module-level const. The
// async `getStripeCredentials()` bootstrap in server.ts runs AFTER this
// module is imported, so `process.env.STRIPE_SECRET_KEY` is still
// undefined at import time. Reading it here with a function instead of at
// module load lets each request see the now-populated env var and return
// a valid Stripe SDK instance. Previously this was a module-level const
// that captured `null` forever, turning every checkout call into
// "Stripe integration is not configured correctly" on dev/test envs.
let stripeClient: Stripe | null = null;
function getStripe(): Stripe | null {
  if (stripeClient) return stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  stripeClient = createStripeClient(key);
  return stripeClient;
}

/**
 * @route GET /api/stripe/session/:sessionId
 * @desc Get customer email from Stripe Checkout session
 * @access Public (consider adding authentication if needed)
 */
router.get("/session/:sessionId", async (req: Request, res: Response) => {
  const stripe = getStripe();
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
 * @route POST /api/stripe/create-checkout-session
 * @desc Create a Stripe Checkout session (embedded mode) for a newly registered user
 * @access Private (requires authentication)
 */
router.post(
  "/create-checkout-session",
  authenticateToken,
  async (req: Request, res: Response) => {
    const stripe = getStripe();
  if (!stripe) {
      return res
        .status(500)
        .json({ error: "Stripe integration is not configured correctly." });
    }

    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    const userEmail = authenticatedReq.user?.email;

    if (!userId || !userEmail) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    const { plan, source } = req.body as { plan?: string; source?: string };
    if (!plan) {
      return res.status(400).json({ error: "Plan is required." });
    }

    // Map plan names to Stripe price IDs
    const planPriceMap: Record<string, string> = {
      starter: process.env.STRIPE_STARTER_PRICE_ID || "",
      complete: process.env.STRIPE_COMPLETE_PRICE_ID || "",
      pro: process.env.STRIPE_COMPLETE_PRICE_ID || "",
    };

    const priceId = planPriceMap[plan.toLowerCase()];
    if (!priceId) {
      return res.status(400).json({ error: `Unknown plan: ${plan}` });
    }

    try {
      // Find or create Stripe customer
      // Find or reuse Stripe customer — defensive against stale DB IDs
      // (customer deleted from Stripe dashboard) and duplicate customers
      // (multiple records for the same email because DB lost track).
      const user = await userDb.getUserById(userId);
      let customerId: string | null = user?.stripe_customer_id || null;

      // Step 1: if DB has a customer ID, verify it still exists in Stripe.
      // Treat "deleted" or "No such customer" as missing so we don't pass a
      // dead ID to checkout.sessions.create and 500.
      if (customerId) {
        try {
          const existing = await stripe.customers.retrieve(customerId);
          if ((existing as any).deleted) {
            customerId = null;
          }
        } catch (err: any) {
          const code = err?.code || err?.raw?.code;
          const status = err?.statusCode || err?.raw?.statusCode;
          if (code === "resource_missing" || status === 404) {
            customerId = null;
          } else {
            throw err;
          }
        }
      }

      // Step 2: no valid customer on file. Search Stripe by email BEFORE
      // creating a new one — prevents duplicate customer records piling up
      // (the cus_ABC vs cus_DEF orphan problem).
      if (!customerId) {
        // Escape backslash first, then double-quote, before interpolating into
        // Stripe's search DSL. Without this, an attacker who registered with a
        // crafted email (registration allows `"` and `\`) could inject
        // additional search clauses and link another user's Stripe customer
        // to their DB row — e.g. `foo" OR metadata["userId"]:"victim"`.
        const escapedEmail = userEmail
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');
        const searchResult = await stripe.customers.search({
          query: `email:"${escapedEmail}"`,
          limit: 1,
        });
        const existingByEmail = searchResult.data.find(
          (c) => !(c as any).deleted
        );
        if (existingByEmail) {
          customerId = existingByEmail.id;
        } else {
          const customer = await stripe.customers.create({
            email: userEmail,
            metadata: { userId },
          });
          customerId = customer.id;
        }
        await userDb.updateUser(userId, { stripe_customer_id: customerId });
      }

      // Free trials removed (product decision, 2026-04). New users pay on
      // first checkout. Refunds are handled manually by Harsha for
      // dissatisfied users. Do NOT reintroduce trial_period_days here.
      // Any existing `has_used_trial: true` values in DynamoDB are harmless
      // residue and can be ignored.
      const sessionParams: any = {
        ui_mode: "embedded",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        allow_promotion_codes: true,
        return_url: `${CUSTOMER_FRONTEND_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      };

      // Source-specific auto-applied coupons. The onboarding welcome-offer
      // flash sale lands a user on the Pro plan with the welcome coupon
      // already attached (no manual code entry). The coupon must exist in
      // the Stripe dashboard with the id from STRIPE_WELCOME_OFFER_COUPON_ID
      // — recommended config: 90% off, duration=repeating,
      // duration_in_months=3. If the env var is unset we log a warning and
      // fall back to full price (allow_promotion_codes still lets the user
      // type a code manually) — better than blocking checkout.
      if (source === "onboarding_welcome_offer") {
        const welcomeCoupon = process.env.STRIPE_WELCOME_OFFER_COUPON_ID;
        if (welcomeCoupon) {
          sessionParams.discounts = [{ coupon: welcomeCoupon }];
          // discounts and allow_promotion_codes are mutually exclusive in
          // Stripe; remove the latter when we're auto-applying.
          delete sessionParams.allow_promotion_codes;
        } else {
          console.warn(
            "[stripe] welcome-offer source supplied but STRIPE_WELCOME_OFFER_COUPON_ID env var unset — checkout will land at full price"
          );
        }
      }

      const session = await stripe.checkout.sessions.create(sessionParams);

      res.json({ clientSecret: session.client_secret });
    } catch (error: any) {
      console.error("Error creating checkout session:", error.message);
      res.status(500).json({ error: "Failed to create checkout session." });
    }
  }
);

/** Customer-safe package catalog. Provider-credit dollar values stay server-side. */
router.get('/usage-top-up-options', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) return res.status(401).json({ error: 'User not authenticated.' });
    const billingUserId = await resolveBillingUserId(userId);
    const tier = await getUserSubscriptionType(billingUserId);
    const config = (await getSubscriptionTypeConfig(tier))?.llmUsageTopUp;
    const packages = getActiveLlmUsageTopUpPackages(config).map(({ id, label, priceCents }) => ({
      id,
      label,
      priceCents,
    }));
    res.json({ enabled: packages.length > 0, packages });
  } catch (error: any) {
    console.error('Error loading usage top-up options:', error.message);
    res.status(500).json({ error: 'Failed to load additional usage options.' });
  }
});

router.post('/create-usage-top-up-session', authenticateToken, async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ error: 'Stripe integration is not configured correctly.' });
  try {
    const auth = req as AuthenticatedRequest;
    const userId = auth.user?.userId;
    if (!userId) return res.status(401).json({ error: 'User not authenticated.' });
    const billingUserId = await resolveBillingUserId(userId);
    const billingUser = await userDb.getUserById(billingUserId);
    if (!billingUser) return res.status(404).json({ error: 'Billing user not found.' });

    const tier = await getUserSubscriptionType(billingUserId);
    const tierConfig = await getSubscriptionTypeConfig(tier);
    const packageConfig = resolveLlmUsageTopUpPackage(tierConfig?.llmUsageTopUp, String(req.body?.packageId || ''));
    if (!packageConfig || !tierConfig?.llmUsageTopUp) {
      return res.status(400).json({ error: 'That additional usage option is unavailable.' });
    }

    let customerId = billingUser.stripe_customer_id || null;
    if (!customerId) {
      const escapedEmail = billingUser.email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const search = await stripe.customers.search({ query: `email:"${escapedEmail}"`, limit: 1 });
      customerId = search.data.find((customer) => !(customer as any).deleted)?.id || null;
      if (!customerId) {
        customerId = (await stripe.customers.create({ email: billingUser.email, metadata: { userId: billingUserId } })).id;
      }
      await userDb.updateUser(billingUserId, { stripe_customer_id: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      customer: customerId,
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: packageConfig.priceCents,
          product_data: { name: packageConfig.label },
        },
      }],
      metadata: {
        purchaseType: 'llm_usage_top_up',
        billingUserId,
        packageId: packageConfig.id,
        usageCreditMicroUsd: String(packageConfig.usageCreditMicroUsd),
        minimumMarkupBps: String(tierConfig.llmUsageTopUp.minimumMarkupBps),
        usagePolicyVersion: tierConfig.llmUsagePolicy?.version || '',
      },
      return_url: `${CUSTOMER_FRONTEND_URL}/?usage_top_up=success&session_id={CHECKOUT_SESSION_ID}`,
    });
    res.json({ clientSecret: session.client_secret });
  } catch (error: any) {
    console.error('Error creating usage top-up checkout:', error.message);
    res.status(500).json({ error: 'Failed to start additional usage checkout.' });
  }
});

/**
 * @route GET /api/stripe/config
 * @desc Return Stripe publishable key to frontend
 * @access Public
 */
router.get("/config", (_req: Request, res: Response) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res.status(500).json({ error: "Stripe publishable key not configured." });
  }
  res.json({ publishableKey });
});

/**
 * @route POST /api/stripe/upgrade
 * @desc Upgrade an existing subscription to a different plan (proration handled by Stripe)
 * @access Private (requires authentication)
 */
router.post(
  "/upgrade",
  authenticateToken,
  async (req: Request, res: Response) => {
    const stripe = getStripe();
  if (!stripe) {
      return res
        .status(500)
        .json({ error: "Stripe integration is not configured correctly." });
    }

    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    const userEmail = authenticatedReq.user?.email;

    if (!userId || !userEmail) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    const { plan, newPriceId } = req.body;

    // Resolve price ID from plan name or use direct newPriceId
    const planPriceMap: Record<string, string> = {
      starter: process.env.STRIPE_STARTER_PRICE_ID || "",
      complete: process.env.STRIPE_COMPLETE_PRICE_ID || "",
      pro: process.env.STRIPE_COMPLETE_PRICE_ID || "",
    };

    const resolvedPriceId = newPriceId || (plan ? planPriceMap[plan.toLowerCase()] : null);
    if (!resolvedPriceId) {
      return res.status(400).json({ error: "A valid plan or newPriceId is required." });
    }

    // Whitelist against known env-configured price IDs. Without this,
    // an authenticated user could pass an arbitrary newPriceId and
    // downgrade their billing to any active price in the Stripe account
    // (legacy $1 dev/test prices in particular are dangerous to expose).
    // `plan` goes through planPriceMap which is already safe; `newPriceId`
    // is the unsafe override and must match a known env value.
    const KNOWN_PRICE_IDS = [
      process.env.STRIPE_STARTER_PRICE_ID,
      process.env.STRIPE_COMPLETE_PRICE_ID,
    ].filter(Boolean);
    if (!KNOWN_PRICE_IDS.includes(resolvedPriceId)) {
      return res.status(400).json({ error: "Invalid plan or price ID." });
    }

    try {
      const user = await userDb.getUserById(userId);
      if (!user || !user.stripe_customer_id) {
        return res.status(400).json({
          error: "No Stripe customer found. Please subscribe first.",
        });
      }

      // Import stripeService to use the new methods
      const { stripeService } = await import("../services/stripeService");

      // Find the active subscription
      const currentSub = await stripeService.findActiveSubscription(user.stripe_customer_id);
      if (!currentSub) {
        return res.status(404).json({
          error: "No active subscription found. Please subscribe first.",
        });
      }

      // Check if user is already on this price
      const currentPriceId = currentSub.items.data[0]?.price?.id;
      if (currentPriceId === resolvedPriceId) {
        return res.status(400).json({
          error: "You are already on this plan.",
        });
      }

      // Route upgrade vs downgrade: upgrades apply immediately with
      // proration, downgrades are scheduled for period-end to avoid
      // generating a confusing prorated-credit line on the next invoice.
      const { changeSubscriptionPrice, deriveSubscriptionTypeFromPriceId } =
        await import("../services/stripeService");
      const result = await changeSubscriptionPrice(currentSub.id, resolvedPriceId);

      if (result.kind === "same_price") {
        return res.status(400).json({ error: "You are already on this plan." });
      }

      if (result.kind === "downgrade_scheduled") {
        // User stays on current tier until period end — we do NOT write the
        // new tier to DB here. When Stripe's subscription_schedule fires at
        // period end, it emits customer.subscription.updated which our
        // webhook handler will sync the new tier.
        //
        // BUT we DO cache the scheduled change itself (schedule id, target
        // price/tier, effectiveAt) so the UI can surface "your plan changes
        // on X" without re-querying Stripe on every /auth/me. This cached
        // hint is cleared by subscription_schedule.{completed,released,
        // canceled} webhooks or an explicit cancel call.
        const currentTierName = currentPriceId
          ? deriveSubscriptionTypeFromPriceId(currentPriceId)
          : null;
        const toTier = deriveSubscriptionTypeFromPriceId(resolvedPriceId) ?? 'unknown';
        const scheduleId = (result as any).schedule?.id ?? '';
        await userDb.updateUser(userId, {
          scheduledChange: {
            stripeScheduleId: scheduleId,
            toPriceId: resolvedPriceId,
            toTier,
            effectiveAt: result.effectiveAt!,
          },
        });
        console.log(
          `[STRIPE DOWNGRADE] User ${userId} scheduled downgrade to ${plan || resolvedPriceId} at ${result.effectiveAt} (schedule=${scheduleId})`
        );
        return res.json({
          message: `Your plan will change to ${plan || "the selected plan"} at the end of the current period.`,
          kind: "downgrade_scheduled",
          effectiveAt: result.effectiveAt,
          // Echo current state for UI — nothing has actually changed yet
          subscriptionType: currentTierName,
          subscription_status: currentSub.status,
        });
      }

      // kind === 'upgrade_immediate' — mirror existing DB-write logic
      const updated = result.subscription;
      const newTierName = deriveSubscriptionTypeFromPriceId(resolvedPriceId);

      const { getTierConfig } = await import("../services/subscriptionService");
      const tierConfig = newTierName ? await getTierConfig(newTierName) : null;

      const updateData: Record<string, any> = {
        stripe_subscription_id: updated.id,
        subscription_status: updated.status,
      };

      if (newTierName) {
        updateData.subscriptionType = newTierName;
      }
      if (tierConfig) {
        updateData.allowedPages = tierConfig.allowedPages;
        updateData.allowedSkills = tierConfig.allowedSkills;
      }

      const periodEnd =
        (updated.items?.data?.[0] as any)?.current_period_end ??
        (updated as any).current_period_end;
      if (periodEnd) {
        updateData.current_period_end = new Date(
          typeof periodEnd === "number" ? periodEnd * 1000 : periodEnd
        ).toISOString();
      }

      await userDb.updateUser(userId, updateData);

      console.log(
        `[STRIPE UPGRADE] User ${userId} upgraded to ${newTierName || "unknown tier"} (price=${resolvedPriceId})`
      );

      res.json({
        message: "Subscription upgraded successfully.",
        kind: "upgrade_immediate",
        subscriptionType: newTierName,
        subscription_status: updated.status,
        current_period_end: updateData.current_period_end,
      });
    } catch (error: any) {
      console.error("Error upgrading subscription:", error.message);
      res.status(500).json({ error: "Failed to upgrade subscription." });
    }
  }
);

/**
 * @route POST /api/stripe/cancel-scheduled-downgrade
 * @desc Release an active subscription_schedule (user changed their mind
 *       about their queued downgrade). Returns to the plain subscription at
 *       its current price. No proration because we're not changing prices
 *       yet — the scheduled change just gets torn down before it fires.
 *
 *       Stripe fires subscription_schedule.released in response to this,
 *       which our webhook handler uses to clear the cached scheduledChange
 *       on the user record. We also clear it optimistically here so the
 *       next /auth/me doesn't show a stale pending change if the webhook
 *       races or drops.
 * @access Private (requires authentication)
 */
router.post(
  "/cancel-scheduled-downgrade",
  authenticateToken,
  async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) {
      return res
        .status(500)
        .json({ error: "Stripe integration is not configured correctly." });
    }

    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    try {
      const user = await userDb.getUserById(userId);
      if (!user?.scheduledChange?.stripeScheduleId) {
        return res
          .status(404)
          .json({ error: "No scheduled change to cancel." });
      }

      await stripe.subscriptionSchedules.release(
        user.scheduledChange.stripeScheduleId
      );
      // Optimistic clear — webhook (subscription_schedule.released) will
      // also clear this, but clearing here prevents a race where /auth/me
      // returns the stale scheduledChange before the webhook lands.
      await userDb.updateUser(userId, { scheduledChange: null });

      console.log(
        `[STRIPE] User ${userId} canceled scheduled downgrade (schedule=${user.scheduledChange.stripeScheduleId})`
      );
      res.json({
        message: "Scheduled change canceled. You stay on your current plan.",
      });
    } catch (error: any) {
      console.error(
        "Error canceling scheduled downgrade:",
        error.message
      );
      res
        .status(500)
        .json({ error: "Failed to cancel scheduled change." });
    }
  }
);

/**
 * @route POST /api/stripe/create-customer-portal-session
 * @desc Create a Stripe Customer Portal session for the authenticated user
 * @access Private (requires authentication)
 */
router.post(
  "/create-customer-portal-session",
  authenticateToken,
  async (req: Request, res: Response) => {
    const stripe = getStripe();
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
      });
    }
  }
);

/**
 * @route POST /api/stripe/cancel-subscription
 * @desc Cancel the authenticated user's subscription at the end of the current billing period
 * @access Private (requires authentication)
 */
router.post(
  "/cancel-subscription",
  authenticateToken,
  async (req: Request, res: Response) => {
    const stripe = getStripe();
  if (!stripe) {
      return res
        .status(500)
        .json({ error: "Stripe integration is not configured correctly." });
    }

    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    try {
      const user = await userDb.getUserById(userId);
      if (!user || !user.stripe_customer_id) {
        return res
          .status(400)
          .json({ error: "No subscription found for this account." });
      }

      // Find the user's active subscription
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: "active",
        limit: 1,
      });

      if (subscriptions.data.length === 0) {
        // Also check for trialing subscriptions
        const trialingSubscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: "trialing",
          limit: 1,
        });

        if (trialingSubscriptions.data.length === 0) {
          return res
            .status(404)
            .json({ error: "No active subscription found." });
        }

        subscriptions.data = trialingSubscriptions.data;
      }

      const subscription = subscriptions.data[0];

      // If the subscription is attached to a subscription_schedule (e.g. a
      // discount/coupon or a tier change applied via Stripe Subscription
      // Schedules), Stripe REJECTS a direct cancel_at_period_end update with
      // "The subscription is managed by the subscription schedule ..., and
      // updating any cancelation behavior directly is not allowed." That bug
      // made "Switch to Free" return 500 for any customer who had a scheduled
      // change or sales-applied coupon. Release the schedule first so the
      // subscription becomes independently updatable — releasing preserves the
      // subscription's current price/discount, it just detaches the schedule.
      const scheduleId =
        typeof (subscription as any).schedule === "string"
          ? (subscription as any).schedule
          : (subscription as any).schedule?.id;
      if (scheduleId) {
        await stripe.subscriptionSchedules.release(scheduleId);
      }

      // Cancel at period end (graceful cancellation)
      const updated: Stripe.Subscription = await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
      });

      // Read current_period_end defensively. The 2025-05-28.basil API
      // moved this field from subscription.current_period_end to
      // subscription.items.data[0].current_period_end. Prior code crashed
      // with "Invalid time value" when the top-level field was null.
      // Trialing subs also have null on both fields until trial ends.
      const periodEndUnix =
        (updated as any).current_period_end ??
        (updated as any).items?.data?.[0]?.current_period_end ??
        null;
      const periodEnd = periodEndUnix
        ? new Date(periodEndUnix * 1000).toISOString()
        : null;

      // Update user record. `subscription_status: "canceling"` is a
      // pseudo-status for the UI. Stripe keeps the sub active/trialing
      // until period end; then customer.subscription.deleted fires and
      // the webhook handler clears the fields.
      const updateData: Record<string, any> = {
        subscription_status: "canceling",
      };
      if (periodEnd) updateData.current_period_end = periodEnd;
      // If we just released a schedule, any cached pending change is now void.
      // Clear it optimistically (the subscription_schedule.released webhook
      // also clears it) so /auth/me doesn't surface a stale scheduledChange.
      if (scheduleId) updateData.scheduledChange = null;
      await userDb.updateUser(userId, updateData);

      res.json({
        message: "Subscription will be canceled at the end of the billing period.",
        cancel_at_period_end: updated.cancel_at_period_end,
        current_period_end: periodEnd,
      });
    } catch (error: any) {
      console.error("Error canceling subscription:", error.message);
      res.status(500).json({ error: "Failed to cancel subscription." });
    }
  }
);

/**
 * @route POST /api/stripe/reactivate-subscription
 * @desc Reactivate a subscription that was canceled but hasn't expired yet
 * @access Private (requires authentication)
 */
router.post(
  "/reactivate-subscription",
  authenticateToken,
  async (req: Request, res: Response) => {
    const stripe = getStripe();
  if (!stripe) {
      return res
        .status(500)
        .json({ error: "Stripe integration is not configured correctly." });
    }

    const authenticatedReq = req as AuthenticatedRequest;
    const userId = authenticatedReq.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "User not authenticated." });
    }

    try {
      const user = await userDb.getUserById(userId);
      if (!user || !user.stripe_customer_id) {
        return res
          .status(400)
          .json({ error: "No subscription found for this account." });
      }

      // Find the user's subscription (could be active with
      // cancel_at_period_end=true). Mirror /cancel-subscription's logic and
      // fall back to status=trialing if no active sub is found — otherwise
      // a user who hit cancel during a free trial cannot reactivate.
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: "active",
        limit: 1,
      });

      if (subscriptions.data.length === 0) {
        const trialingSubscriptions = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: "trialing",
          limit: 1,
        });

        if (trialingSubscriptions.data.length === 0) {
          return res
            .status(404)
            .json({ error: "No active subscription found to reactivate." });
        }

        subscriptions.data = trialingSubscriptions.data;
      }

      const subscription = subscriptions.data[0];

      if (!subscription.cancel_at_period_end) {
        return res
          .status(400)
          .json({ error: "Subscription is not canceled. No reactivation needed." });
      }

      // Reactivate by removing the cancel_at_period_end flag
      const updated: Stripe.Subscription = await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: false,
      });

      // Read current_period_end defensively — same pattern as PR #1262
      // applied to /cancel-subscription. The 2025-05-28.basil API moved
      // this field from subscription.current_period_end to
      // subscription.items.data[0].current_period_end, and trialing subs
      // have null until trial ends. Without this the endpoint crashes with
      // "Invalid time value" when the top-level field is null.
      const periodEndUnix =
        (updated as any).current_period_end ??
        (updated as any).items?.data?.[0]?.current_period_end ??
        null;
      const periodEnd = periodEndUnix
        ? new Date(periodEndUnix * 1000).toISOString()
        : null;

      const updateData: Record<string, any> = { subscription_status: "active" };
      if (periodEnd) updateData.current_period_end = periodEnd;
      await userDb.updateUser(userId, updateData);

      res.json({
        message: "Subscription reactivated successfully.",
        cancel_at_period_end: updated.cancel_at_period_end,
        current_period_end: periodEnd,
      });
    } catch (error: any) {
      console.error("Error reactivating subscription:", error.message);
      res.status(500).json({ error: "Failed to reactivate subscription." });
    }
  }
);

/**
 * @route POST /api/stripe/reconcile
 * @desc Admin-only: reconcile all users' Stripe data with DynamoDB.
 *       Should be called periodically (e.g., weekly cron or from the partner
 *       portal admin panel) to fix any drift caused by missed webhooks.
 *       Also useful after bulk subscription changes or Stripe migrations.
 * @access Private (admin only)
 */
router.post(
  "/reconcile",
  authenticateToken,
  requireAdmin,
  stripeController.reconcile
);

/**
 * @route POST /api/stripe/webhook
 * @desc Handle Stripe webhook events (signature-verified, raw body)
 * @access Public (Stripe sends directly — no auth)
 */
router.post(
  "/webhook",
  stripeController.handleWebhook
);

/**
 * @route GET /api/stripe/products
 * @desc List active Stripe products with prices
 * @access Public
 */
router.get("/products", stripeController.listProducts);

/**
 * @route GET /api/stripe/payment-history/:userId
 * @desc Get payment history for a user (admin only)
 * @access Private (admin only)
 */
router.get(
  "/payment-history/:userId",
  authenticateToken,
  requireAdmin,
  stripeController.getPaymentHistory
);

export default router;
