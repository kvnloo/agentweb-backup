import express from "express";
import { userDb, orgDb } from "../services/db";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { userId } = (req as any).user;
    const user = await userDb.getUserById(userId);
    if (!user?.orgId) return res.status(404).json({ message: "No org" });
    const org = await orgDb.getOrgById(user.orgId);
    if (!org) return res.status(404).json({ message: "Org not found" });
    return res.json({ shareSettings: org.shareSettings ?? null });
  } catch (e) {
    console.error("Error fetching org share-settings:", e);
    return res.status(500).json({ message: "Failed to fetch share-settings" });
  }
});

export default router;
