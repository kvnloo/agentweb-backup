import express from "express";
import rateLimit from "express-rate-limit";
import { verifyWebhookToken } from "../services/smartleadWebhookToken";
import { parseSmartleadEvent } from "../services/smartleadEvents";
import { getSmartleadEventService } from "../services/smartleadEventRuntime";
import { getJwtSecret } from "../config/jwt";

/**
 * Smartlead events for a campaign AgentWeb pushed into (ENG-673, slice 3): a reply, a bounce or an unsubscribe. The URL carries the account, the
 * campaign and an HMAC token that is checked before anything else; there is deliberately no user authentication (Smartlead cannot log in).
 *
 * Not behind the push kill switch on purpose: stopping pushes must never stop an opt-out from reaching the CRM (the same rule as the withdrawal
 * sweep). Answers: 404 for a bad token (no detail), 200 for anything we choose not to act on (so Smartlead does not retry what can never work),
 * 5xx only when handling failed and a retry can help (every effect is idempotent, so a retry is safe).
 */
const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
});

// Keys only, never values: which fields a payload carries is what we need to learn from live events.
const shape = (body: unknown): string => (body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as object).slice(0, 40).join(",") : typeof body);

router.post("/:accountId/:campaignId/:token", limiter, async (req: express.Request, res: express.Response) => {
  const { accountId, campaignId, token } = req.params;
  if (!/^\d{1,12}$/.test(campaignId) || !verifyWebhookToken(getJwtSecret(), accountId, campaignId, token)) return res.status(404).json({});

  let body: unknown;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    body = JSON.parse(raw);
  } catch {
    console.warn(`[SmartleadWebhook] campaign=${campaignId} body is not JSON`);
    return res.status(200).json({ ok: true, ignored: "bad_json" });
  }
  // Discovery aid for a test environment ONLY (never set in production): the whole body, cut short.
  if (process.env.SMARTLEAD_WEBHOOK_LOG_BODY === "true") console.log(`[SmartleadWebhook] body campaign=${campaignId} ${JSON.stringify(body).slice(0, 2000)}`);

  const parsed = parseSmartleadEvent(body);
  if (!parsed.ok) {
    console.log(`[SmartleadWebhook] campaign=${campaignId} ignored=${parsed.reason} keys=${shape(body)}`);
    return res.status(200).json({ ok: true, ignored: parsed.reason });
  }
  try {
    const outcome = await getSmartleadEventService().handle({ accountId, campaignId: Number(campaignId) }, parsed.event);
    console.log(`[SmartleadWebhook] campaign=${campaignId} kind=${parsed.event.kind} matched=${outcome.matched} changed=${outcome.changed} duplicates=${outcome.duplicates} keys=${shape(body)}`);
    return res.status(200).json({ ok: true, ...outcome });
  } catch (e) {
    console.error(`[SmartleadWebhook] campaign=${campaignId} kind=${parsed.event.kind} failed:`, e instanceof Error ? e.message : String(e));
    return res.status(500).json({ error: "Something went wrong." });
  }
});

export default router;
