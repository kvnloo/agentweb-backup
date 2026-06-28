import express from "express";
import {
  getNotionPage,
  getNotionPageContent,
  getNotionCommentText,
  getNotionBotUserId,
  relayPromptToEC2,
  launchEnvironment,
  teardownEnvironment,
  updateNotionPageProperties,
} from "../services/devEnvService";

const router = express.Router();

// In-process lock: page IDs currently being launched, to deduplicate concurrent
// webhook deliveries hitting the same backend instance simultaneously.
const launchingPageIds = new Set<string>();

/**
 * POST /api/webhooks/notion-dev-env
 *
 * Notion automation webhook. Handles:
 * - page.properties_updated: Status changes (Start/Done/Deploy)
 * - comment.created: User comments relayed to Claude Code on EC2
 *
 * Responds 200 immediately, then fires-and-forgets the async work.
 */
router.post(
  "/webhooks/notion-dev-env",
  async (req: express.Request, res: express.Response) => {
    try {
      const body = req.body;

      // Handle Notion webhook verification request
      if (body?.verification_token) {
        console.log("[devEnv] Webhook verification request received. Token:", body.verification_token);
        return res.status(200).json({ verification_token: body.verification_token });
      }

      // Detect event type
      const eventType = body?.type || "";

      // Log a compact summary, not the full payload. The Notion dev-env webhook
      // fires on every page edit; dumping the entire JSON body on each delivery
      // is unnecessary stdout volume that journald/rsyslog persist to
      // /var/log/messages. (The catastrophic disk-fill source — full AWS-SDK
      // error graphs from the teardownEnvironment retry loop — was already fixed
      // in devEnvService.ts; this just trims the routine per-webhook noise.)
      console.log(
        `[devEnv] Webhook: type="${eventType}", entity=${body?.entity?.id || "n/a"}`
      );

      // --- comment.created ---
      if (eventType === "comment.created") {
        const commentId = body?.entity?.id;
        const pageId = body?.data?.page_id || body?.data?.parent?.id;

        if (!commentId || !pageId) {
          console.warn("[devEnv] comment.created missing commentId or pageId");
          return res.status(400).json({ error: "Missing commentId or pageId" });
        }

        // Check if the comment was created by the bot (prevent infinite loops)
        const commentAuthorId = body?.authors?.[0]?.id || body?.data?.created_by?.id;
        let botUserId: string | undefined;
        try {
          botUserId = await getNotionBotUserId();
        } catch (err) {
          console.warn("[devEnv] Could not fetch bot user ID:", err);
        }

        if (botUserId && commentAuthorId === botUserId) {
          console.log(`[devEnv] Skipping bot's own comment ${commentId}`);
          return res.status(200).json({ action: "none", reason: "bot_comment" });
        }

        // Check if page has a running environment
        const page = await getNotionPage(pageId);
        if (!page.instanceId || !page.publicIp) {
          console.log(`[devEnv] No running env for page ${pageId}, skipping comment`);
          return res.status(200).json({ action: "none", reason: "no_instance" });
        }

        // Only relay if this environment launched the instance
        const currentEnv = process.env.NODE_ENV || "development";
        if (page.launchedBy && page.launchedBy !== currentEnv) {
          console.log(`[devEnv] Instance launched by "${page.launchedBy}", current env is "${currentEnv}", skipping`);
          return res.status(200).json({ action: "none", reason: "wrong_environment" });
        }

        // Fetch comment text
        const commentText = await getNotionCommentText(pageId, commentId);
        if (!commentText) {
          console.log(`[devEnv] Empty or unfound comment ${commentId}`);
          return res.status(200).json({ action: "none", reason: "empty_comment" });
        }

        // Relay to EC2
        res.status(200).json({ action: "relaying_comment", pageId, commentId });

        void (async () => {
          try {
            await relayPromptToEC2(page.publicIp, commentText, pageId);
          } catch (err) {
            console.error(`[devEnv] Background comment relay failed:`, err);
          }
        })();

        return;
      }

      // --- page.properties_updated (status changes) ---
      const pageId =
        body?.entity?.id ||
        body?.data?.id ||
        body?.page_id ||
        body?.id;

      if (!pageId) {
        console.warn("[devEnv] Webhook received without page_id:", JSON.stringify(body));
        return res.status(400).json({ error: "Missing page_id in payload" });
      }

      const page = await getNotionPage(pageId);
      console.log(
        `[devEnv] Webhook for page ${pageId}: status="${page.status}", title="${page.title}", instanceId="${page.instanceId}"`
      );

      const isProduction = process.env.NODE_ENV === "production";
      const isLaunchStatus = isProduction ? page.status === "Start" : page.status === "Start_Test";
      const isTeardownStatus = isProduction ? page.status === "Done" : page.status === "Done_Test";
      const isDeployStatus = isProduction ? page.status === "Deploy" : page.status === "Deploy_Test";

      if (isLaunchStatus && !page.instanceId) {
        // Guard 1: in-process lock (same backend instance, concurrent requests)
        if (launchingPageIds.has(pageId)) {
          console.log(`[devEnv] Launch already in progress for ${pageId}, skipping duplicate`);
          return res.status(200).json({ action: "none", reason: "already_launching" });
        }
        launchingPageIds.add(pageId);

        // Guard 2: optimistic lock — write "pending" to Notion immediately so
        // other backend instances (or later webhook retries) see a non-empty
        // instanceId and bail out before starting their own launch.
        try {
          await updateNotionPageProperties(pageId, { instanceId: "pending" });
        } catch (lockErr) {
          launchingPageIds.delete(pageId);
          console.error(`[devEnv] Could not write pending lock to Notion for ${pageId}:`, lockErr);
          return res.status(500).json({ error: "Failed to acquire launch lock" });
        }

        // Launch
        res.status(200).json({ action: "launching", pageId });

        void (async () => {
          try {
            const { text } = await getNotionPageContent(pageId);
            await launchEnvironment(pageId, page.title, text, page.databaseId);
          } catch (err) {
            console.error(`[devEnv] Background launch failed:`, err);
          } finally {
            launchingPageIds.delete(pageId);
          }
        })();
      } else if (isDeployStatus && page.instanceId && page.publicIp) {
        // Deploy: relay "Prep for deploy" to Claude Code on EC2
        res.status(200).json({ action: "deploying", pageId });

        void (async () => {
          try {
            await relayPromptToEC2(page.publicIp, "Prep for deploy", pageId);
          } catch (err) {
            console.error(`[devEnv] Background deploy relay failed:`, err);
          }
        })();
      } else if (isTeardownStatus && page.instanceId) {
        // Teardown
        res.status(200).json({ action: "tearing_down", pageId });

        void (async () => {
          try {
            await teardownEnvironment(pageId);
          } catch (err) {
            console.error(`[devEnv] Background teardown failed:`, err);
          }
        })();
      } else {
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
