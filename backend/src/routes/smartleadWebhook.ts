import express from "express";
import rateLimit from "express-rate-limit";
import { verifyWebhookToken, webhookSecret } from "../services/smartleadWebhookToken";
import { parseSmartleadEvent } from "../services/smartleadEvents";
import { getSmartleadEventService } from "../services/smartleadEventRuntime";

/**
 * Smartlead events for a campaign AgentWeb pushed into (ENG-673, slice 3): a reply, a bounce or an unsubscribe. The URL carries the account, the
 * campaign and an HMAC token. There is deliberately no user authentication (Smartlead cannot log in); the token IS the authentication.
 *
 * ORDER MATTERS, and is why the parts below are exported as `smartleadWebhookPreParse` and mounted in app.ts BEFORE the global body parsers:
 *   1. the token is checked first, so an anonymous caller gets a bare 404 and never reaches the body parser or the limiter;
 *   2. only then is the body read (capped at 256 kb); a parser error (too large, malformed) is answered here with a bare 4xx, never handed to
 *      the global error handler (which would report it as a UI error and answer 500);
 *   3. the limiter counts only requests with a valid token, per account and campaign, with a ceiling far above any real burst: an opt-out
 *      must never be refused because of somebody else's traffic.
 * Not behind the push kill switch on purpose: stopping pushes must never stop an opt-out from reaching the CRM (the same rule as the withdrawal
 * sweep). Answers: 404 for a bad token (no detail), 200 for anything we choose not to act on (so Smartlead does not retry what can never work),
 * 5xx only when handling failed and a retry can help (every effect is idempotent, so a retry is safe).
 */
const PATH = /^\/([^/]{1,200})\/(\d{1,12})\/([^/]{1,200})\/?$/;

const gate: express.RequestHandler = (req, res, next) => {
  const m = PATH.exec(req.path);
  let ok = false;
  try {
    ok = req.method === "POST" && !!m && verifyWebhookToken(webhookSecret(), m[1], m[2], m[3]);
  } catch {
    return res.status(500).json({}); // the secret could not be read: nothing can be verified
  }
  if (!ok) return res.status(404).json({});
  next();
};

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const m = PATH.exec(req.path);
    return m ? `${m[1]}:${m[2]}` : "none"; // only reached with a valid token
  },
  validate: { keyGeneratorIpFallback: false },
  message: { error: "Too many requests." },
});

const rawBody = express.raw({ type: "*/*", limit: "256kb" });

// A body the parser rejects (too large, bad encoding) is the caller's problem: a bare 4xx, no report, no detail.
const parserErrors: express.ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 500 ? err.status : 400;
  return res.status(status).json({});
};

export const smartleadWebhookPreParse: Array<express.RequestHandler | express.ErrorRequestHandler> = [gate, limiter, rawBody, parserErrors];

const router = express.Router();

// Keys only, never values: which fields a payload carries is what we need to learn from live events.
const shape = (body: unknown): string => (body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as object).slice(0, 40).join(",") : typeof body);

router.post("/:accountId/:campaignId/:token", async (req: express.Request, res: express.Response) => {
  // The gate already proved the token against the raw path segments; account ids and campaign ids are URL-safe, so these are the same values.
  const { accountId, campaignId } = req.params;

  let body: unknown;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    body = JSON.parse(raw);
  } catch {
    console.warn(`[SmartleadWebhook] campaign=${campaignId} body is not JSON`);
    return res.status(200).json({ ok: true, ignored: "bad_json" });
  }
  // Discovery aid for a TEST environment only: refused in production whatever the variable says. The whole body, cut short.
  if (process.env.SMARTLEAD_WEBHOOK_LOG_BODY === "true" && process.env.NODE_ENV !== "production") {
    // Even there: never the secrets a payload carries (our URL token is inside webhook_url) or the text of a reply.
    const redacted = { ...(body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : { value: body }) };
    for (const k of ["secret_key", "webhook_url", "reply_body", "reply_message", "sent_message", "sent_message_body", "preview_text"]) if (k in redacted) redacted[k] = "<redacted>";
    console.log(`[SmartleadWebhook] body campaign=${campaignId} ${JSON.stringify(redacted).slice(0, 2000)}`);
  }

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
