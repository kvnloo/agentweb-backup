import express from "express";
import { waitlistDb } from "../services/waitlistDb";
import { validateEmail } from "../utils/validation";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
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

router.get("/", async (req, res) => {
  try {
    const { lastEvaluatedKey } = req.query;
    const result = await waitlistDb.list(lastEvaluatedKey as any);
    res.json(result);
  } catch (error) {
    console.error("Error listing waitlist:", error);
    res.status(500).json({ message: "Failed to list waitlist entries" });
  }
});

router.put("/:email/status", async (req, res) => {
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
