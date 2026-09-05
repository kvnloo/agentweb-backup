import express from "express";
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
router.get("/", authenticateToken, isAdmin, async (req, res) => {
  try {
    const { lastEvaluatedKey } = req.query;
    const result = await waitlistDb.list(lastEvaluatedKey as any);
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

export default router;
