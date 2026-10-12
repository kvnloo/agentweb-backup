/**
 * ENG-2428 (slice A of ENG-2266): admin-only endpoint that creates a
 * per-account Stripe Checkout link with inline price_data.
 *
 *   POST /api/admin/custom-subscription-links
 *   body: { orgId, label, amountUsd, frequency }
 *   → 200 { url, sessionId, expiresAt }
 *
 * Stateless: no persistence, no webhook mapping, no customer creation. The
 * org owner's existing Stripe customer is required; persistence and the
 * replace-vs-stack plan decision live in ENG-2305.
 */

import express, { Response } from "express";
import Stripe from "stripe";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { AuthRequest } from "../types/express";
import { orgDb, userDb } from "../services/db";
import { createStripeClient } from "../services/stripeClientFactory";
import {
  buildCustomSubscriptionLinkCheckoutParams,
  CustomSubscriptionLinkError,
  type CustomLinkFrequency,
} from "../services/customSubscriptionLinkCheckout";

const FREQUENCIES: readonly CustomLinkFrequency[] = ["one_time", "week", "month", "quarter", "year"];

let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("Stripe SDK not initialized. Missing STRIPE_SECRET_KEY.");
    _stripe = createStripeClient(key);
  }
  return _stripe;
}

const router = express.Router();

router.post(
  "/custom-subscription-links",
  authenticateToken,
  isAdmin,
  async (req: AuthRequest, res: Response) => {
    const { orgId, label, amountUsd, frequency } = req.body ?? {};
    const createdBy = req.user?.userId;

    if (typeof orgId !== "string" || !orgId.trim()) {
      return res.status(400).json({ message: "orgId is required" });
    }
    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ message: "label is required" });
    }
    if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({ message: "amountUsd must be a number greater than 0" });
    }
    if (!FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ message: `frequency must be one of ${FREQUENCIES.join(", ")}` });
    }
    if (!createdBy) return res.status(401).json({ message: "Unauthorized" });

    try {
      const org = await orgDb.getOrgById(orgId.trim(), ["orgId", "ownerUserId"]);
      if (!org) return res.status(404).json({ message: `Organization ${orgId} not found` });
      const owner = org.ownerUserId ? await userDb.getUserById(org.ownerUserId) : null;
      const stripeCustomerId = (owner as any)?.stripe_customer_id;
      if (typeof stripeCustomerId !== "string" || !stripeCustomerId.trim()) {
        return res.status(409).json({
          message: `Organization ${orgId} has no Stripe customer; create one before generating a custom link`,
        });
      }

      const frontend = process.env.FRONTEND_URL || "http://localhost:5173";
      let params: Stripe.Checkout.SessionCreateParams;
      try {
        params = buildCustomSubscriptionLinkCheckoutParams({
          orgId: org.orgId,
          stripeCustomerId,
          label,
          amountUsd,
          frequency,
          createdBy,
          successUrl: `${frontend}/billing?custom_link=success`,
          cancelUrl: `${frontend}/billing?custom_link=cancelled`,
        });
      } catch (err) {
        if (err instanceof CustomSubscriptionLinkError) {
          return res.status(400).json({ message: err.message });
        }
        throw err;
      }

      const session = await getStripe().checkout.sessions.create(params);
      console.log("[adminCustomSubscriptionLinks] created custom link", {
        orgId: org.orgId,
        createdBy,
        label: label.trim(),
        amountUsd,
        frequency,
        sessionId: session.id,
      });
      return res.json({
        url: session.url,
        sessionId: session.id,
        expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      });
    } catch (error) {
      console.error("[adminCustomSubscriptionLinks] failed to create custom link:", error);
      return res.status(502).json({
        message: "Failed to create custom subscription link",
      });
    }
  }
);

export default router;
