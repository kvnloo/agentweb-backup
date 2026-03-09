import express from "express";
import {
  getNotionPage,
  getNotionPageContent,
  launchEnvironment,
  teardownEnvironment,
} from "../services/devEnvService";

const router = express.Router();

/**
 * POST /api/webhooks/notion-dev-env
 *
 * Notion automation webhook. Triggered when a sprint item's Status changes.
 * - Status = "Start" (and no Instance ID) → launch dev environment
 * - Status = "Done" (and Instance ID present) → teardown dev environment
 *
 * Responds 200 immediately, then fires-and-forgets the async EC2 work.
 */
router.post(
  "/webhooks/notion-dev-env",
  async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body;

      // Handle Notion webhook verification request
      // Notion sends {"verification_token": "..."} on initial setup.
      // Respond 200 so the admin can copy the token into the Notion dashboard.
      if (body?.verification_token) {
        console.log("[devEnv] Webhook verification request received. Token:", body.verification_token);
        return res.status(200).json({ verification_token: body.verification_token });
      }

      // Log full payload for debugging during initial setup
      console.log("[devEnv] Webhook payload:", JSON.stringify(body));

      // Extract page ID from the event payload
      // Notion webhook events include entity.id for the affected page
      const pageId =
        body?.entity?.id ||     // Notion webhook event payload
        body?.data?.id ||       // Alternative format
        body?.page_id ||        // Alternative format
        body?.id;               // Direct page ID

      if (!pageId) {
        console.warn("[devEnv] Webhook received without page_id:", JSON.stringify(body));
        return res.status(400).json({ error: "Missing page_id in payload" });
      }

      // Fetch page details from Notion
      const page = await getNotionPage(pageId);
      console.log(
        `[devEnv] Webhook for page ${pageId}: status="${page.status}", title="${page.title}", instanceId="${page.instanceId}"`
      );

      const isProduction = process.env.NODE_ENV === "production";
      const isLaunchStatus = isProduction ? page.status === "Start" : page.status === "Start_Test";
      const isTeardownStatus = isProduction ? page.status === "Done" : page.status === "Done_Test";

      if (isLaunchStatus && !page.instanceId) {
        // Launch: respond 200 immediately, then fire-and-forget
        res.status(200).json({ action: "launching", pageId });

        void (async () => {
          try {
            const { text } = await getNotionPageContent(pageId);
            await launchEnvironment(pageId, page.title, text, page.databaseId);
          } catch (err) {
            console.error(`[devEnv] Background launch failed:`, err);
          }
        })();
      } else if (isTeardownStatus && page.instanceId) {
        // Teardown: respond 200 immediately, then fire-and-forget
        res.status(200).json({ action: "tearing_down", pageId });

        void (async () => {
          try {
            await teardownEnvironment(pageId);
          } catch (err) {
            console.error(`[devEnv] Background teardown failed:`, err);
          }
        })();
      } else {
        // No action needed (e.g., status changed to something else, or dedup)
        console.log(
          `[devEnv] No action for page ${pageId} (status="${page.status}", instanceId="${page.instanceId}")`
        );
        res.status(200).json({ action: "none", pageId });
      }
    } catch (error: any) {
      console.error("[devEnv] Webhook handler error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
