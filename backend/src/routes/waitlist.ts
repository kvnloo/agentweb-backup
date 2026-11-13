import express from "express";
import { AuthenticatedRequest } from '../middleware/auth';
import { admitZoma, applyZomaWaitlistDecision, rejectZoma, zomaApprovedCount, zomaAdmissionEnabled } from '../services/zomaAdmission';
import { waitlistDb } from "../services/waitlistDb";
import { validateEmail } from "../utils/validation";
import { authenticateToken } from "../middleware/auth";
import { isAdmin } from "../middleware/admin";
import { rateLimiter } from "../middleware/rateLimiter";

const router = express.Router();

// Public signup path (ENG-1753 AC3): no auth, but rate-limited per IP so it
// can't be used to spam the waitlist table or the downstream email sends.
const WAITLIST_SIGNUP_MAX_PER_MINUTE = 5;

router.post("/", async (req, res) => {
  try {
    const rateLimitKey = `waitlist-signup:${req.ip}`;
    const rateLimitResult = rateLimiter.check(rateLimitKey, WAITLIST_SIGNUP_MAX_PER_MINUTE);
    if (!rateLimitResult.allowed) {
      return res.status(429).json({
        message: "Too many requests. Please try again later.",
        retryAfterMs: rateLimitResult.resetInMs,
      });
    }

    const {
      email,
      fullName,
      phoneNumber,
      companyName,
      useCaseCategories,
      useCaseDescription,
      requestReport,
      monthlyMarketingSpend,
      businessArea,
      marketingChannels,
    } = req.body;

    if (!email || !validateEmail(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }

    // Check if email already exists in waitlist
    const existingEntry = await waitlistDb.getByEmail(email);
    if (existingEntry) {
      return res.status(409).json({ message: "Email already registered" });
    }

    // Add to waitlist
    const now = new Date().toISOString();
    const waitlistData = {
      email: email.toLowerCase(),
      joinedAt: now,
      status: "pending",
      fullName: fullName || "",
      phoneNumber: phoneNumber || "",
      companyName: companyName || "",
      useCaseCategories: useCaseCategories || [],
      useCaseDescription: useCaseDescription || "",
      requestReport: requestReport || false,
      monthlyMarketingSpend: monthlyMarketingSpend || "",
      businessArea: businessArea || "",
      marketingChannels: marketingChannels || [],
    };

    const entry = await waitlistDb.add(waitlistData);

    res.status(201).json(entry);
  } catch (error) {
    console.error("Error adding to waitlist:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ENG-1753: these leaked full waitlist PII (phone, spend) and allowed anyone
// to flip a status to "invited" with no auth at all. No portal/partner-portal
// client calls these public paths (the partner portal uses /api/admin/waitlist),
// so they are now admin-only, matching the rest of the admin surface.
// The Dynamo pagination cursor is an opaque object we only ever hand back
// verbatim to DynamoDB — but it arrives as untrusted query-string JSON, so
// reject anything that isn't the plain key-shape ExclusiveStartKey expects
// before it reaches waitlistDb.list.
const parseLastEvaluatedKey = (raw: unknown): Record<string, unknown> | undefined => {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("lastEvaluatedKey must be a JSON-encoded object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("lastEvaluatedKey must be valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("lastEvaluatedKey must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

router.get("/", authenticateToken, isAdmin, async (req, res) => {
  try {
    let lastEvaluatedKey: Record<string, unknown> | undefined;
    try {
      lastEvaluatedKey = parseLastEvaluatedKey(req.query.lastEvaluatedKey);
    } catch (validationError: any) {
      return res.status(400).json({ message: validationError.message });
    }
    const result = await waitlistDb.list(lastEvaluatedKey);
    res.json(result);
  } catch (error) {
    console.error("Error listing waitlist:", error);
    res.status(500).json({ message: "Failed to list waitlist entries" });
  }
});

router.put("/:email/status", authenticateToken, isAdmin, async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.body;

    if (!email || !status) {
      return res.status(400).json({ message: "Email and status are required" });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ message: "Invalid email" });
    }

    const refusal = await applyZomaWaitlistDecision(
      await waitlistDb.getByEmail(email), email, status, (req as AuthenticatedRequest).user?.userId,
    );
    if (refusal) return res.status(refusal.statusCode).json(refusal.body);

    const entry = await waitlistDb.updateStatus(
      email,
      status,
      status === "invited" ? new Date().toISOString() : undefined
    );

    res.json(entry);
  } catch (error) {
    console.error("Error updating waitlist status:", error);
    res.status(500).json({ message: "Failed to update waitlist status" });
  }
});

router.get('/zoma/capacity', authenticateToken, isAdmin, async (_req, res) => {
  if (!zomaAdmissionEnabled()) return res.sendStatus(404);
  try { res.json(await zomaApprovedCount()); }
  catch (error) {
    console.error('Zoma capacity read failed', error);
    res.status(503).json({ code: 'admission_unavailable' });
  }
});
router.post('/zoma/:email/decision', authenticateToken, isAdmin, async (req, res) => {
  if (!zomaAdmissionEnabled()) return res.sendStatus(404);
  const { email } = req.params;
  const { decision } = req.body;
  if (!validateEmail(email) || !['approve', 'reject'].includes(decision)) return res.sendStatus(400);
  const actor = (req as AuthenticatedRequest).user?.userId;
  if (!actor) return res.sendStatus(403);
  try {
    const status = decision === 'approve' ? await admitZoma(email, actor) : await rejectZoma(email, actor);
    const expected = decision === 'approve' ? 'approved' : 'rejected';
    res.status(status === expected ? 200 : status === 'not_found' ? 404 : 409).json({ status });
  } catch (error) {
    console.error('Zoma admission decision failed', error);
    res.status(503).json({ code: 'admission_unavailable' });
  }
});

export default router;
