import { createHmac, timingSafeEqual } from "crypto";
import { getJwtSecret } from "../config/jwt";

/**
 * The secret part of the URL AgentWeb gives Smartlead for a campaign's events (ENG-673, slice 3):
 *   /api/webhooks/smartlead/<accountId>/<campaignId>/<token>
 * The token is an HMAC of the account and the campaign, so it needs no storage, cannot be guessed, and a token for one campaign says nothing
 * about another. Smartlead's own signature (a header the docs describe but do not explain how to key) is not relied on.
 */
const DOMAIN = "smartlead-webhook:v1:";

/**
 * The key the URL tokens are made with: SMARTLEAD_WEBHOOK_SECRET when set, else the JWT secret. NOTE the coupling when it is not set:
 * rotating the JWT secret changes every token, so every webhook URL already registered in a customer's Smartlead account stops working
 * (a bad token answers 404). Set a dedicated secret before rotating the JWT secret.
 */
export const webhookSecret = (): string => process.env.SMARTLEAD_WEBHOOK_SECRET || getJwtSecret();

const mac = (secret: string, accountId: string, campaignId: number | string): string =>
  createHmac("sha256", secret).update(DOMAIN + JSON.stringify([accountId, String(campaignId)])).digest("base64url"); // JSON, so no value can be shifted across a separator

export function signWebhookToken(secret: string, accountId: string, campaignId: number | string): string {
  return mac(secret, accountId, campaignId);
}

/** True only for the exact token made for this account and campaign. Never throws; a missing or odd value is simply false. */
export function verifyWebhookToken(secret: string, accountId: unknown, campaignId: unknown, token: unknown): boolean {
  if (typeof accountId !== "string" || !accountId || typeof token !== "string" || !token) return false;
  if (typeof campaignId !== "string" && typeof campaignId !== "number") return false;
  const expected = Buffer.from(mac(secret, accountId, campaignId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
