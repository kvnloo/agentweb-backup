import express, { Request, Response } from "express";
import { authenticateToken, AuthenticatedRequest, isRealAdmin } from "../middleware/auth";
import { batchReviewDb } from "../services/batchReviewDb";
import { approvalDb, getAssetTypeFromFilename } from "../services/approvalDb";
import { sendBatchApprovalRequest, updateBatchReviewMessage, getEffectiveAllowedChannels } from "../services/slackService";
import { userDb } from "../services/db";
import { triggerAutoRevision } from "../services/revisionService";

const router = express.Router();

/**
 * @route POST /api/batch-review/create
 * @desc Create a batch review and send a single Slack message with review page link
 * @access Private (requires authentication)
 */
router.post("/create", authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { channel, channelName, assets, note } = req.body;

  if (!channel || !assets || !Array.isArray(assets) || assets.length === 0) {
    return res.status(400).json({ error: "Missing required fields: channel, assets (non-empty array)" });
  }

  if (typeof channel !== "string") {
    return res.status(400).json({ error: "channel must be a string" });
  }

  // ENG-2407: the bot posts with the workspace token, so the caller may only target a
  // channel configured for their user/org (or be a real, non-delegated admin). Checked
  // before any DB write or Slack call.
  if (!isRealAdmin(req)) {
    let allowed: string[] = [];
    try {
      const user = await userDb.getUserById(userId);
      allowed = await getEffectiveAllowedChannels(user);
    } catch (error: any) {
      console.error("Error resolving allowed Slack channels:", error.message);
      return res.status(500).json({ error: "Failed to create batch review" });
    }
    if (!allowed.includes(channel)) {
      return res.status(403).json({ error: "Not allowed to post to this Slack channel" });
    }
  }

  try {
    // Create batch review record
    const batchAssets = assets.map((a: any) => ({
      assetUrl: a.assetUrl,
      filename: a.filename,
      assetType: a.assetType || getAssetTypeFromFilename(a.filename),
      executionId: a.executionId,
    }));

    const batch = await batchReviewDb.createBatchReview({
      userId,
      slackChannel: channel,
      slackChannelName: channelName || channel,
      note,
      assets: batchAssets,
    });

    // Create individual approval records for each asset
    for (const asset of batchAssets) {
      await approvalDb.createApproval({
        assetUrl: asset.assetUrl,
        filename: asset.filename,
        assetType: asset.assetType,
        executionId: asset.executionId,
        userId,
        slackChannel: channel,
        slackChannelName: channelName || channel,
        slackMessageTs: null, // Will be set per-batch, not per-asset
        note,
        batchId: batch.batchId,
      });
    }

    // Build review page URL
    const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174";
    const reviewPageUrl = `${customerFrontendUrl}/batch-review/${batch.batchId}`;

    // Send ONE Slack message with link to review page
    const slackResult = await sendBatchApprovalRequest({
      channel,
      batchId: batch.batchId,
      assets: batchAssets,
      note,
      reviewPageUrl,
    });

    // Update batch with Slack message timestamp
    if (slackResult.messageTs) {
      await batchReviewDb.updateSlackMessageTs(batch.batchId, slackResult.messageTs);
    }

    res.json({
      success: true,
      batchId: batch.batchId,
      messageTs: slackResult.messageTs,
      reviewPageUrl,
      assetCount: batchAssets.length,
    });
  } catch (error: any) {
    console.error("Error creating batch review:", error.message);
    res.status(500).json({ error: "Failed to create batch review", details: error.message });
  }
});

export default router;

// ---- Public routes (no auth required, secured by batchId UUID) ----

export const batchReviewPublicRouter = express.Router();

/**
 * @route GET /batch-review/:batchId
 * @desc Get batch review data for the public review page
 * @access Public (secured by UUID)
 */
batchReviewPublicRouter.get("/:batchId", async (req: Request, res: Response) => {
  const { batchId } = req.params;

  try {
    const batch = await batchReviewDb.getBatchReview(batchId);
    if (!batch) {
      return res.status(404).json({ error: "Batch review not found" });
    }

    // Fetch individual approval statuses
    const assetUrls = batch.assets.map(a => a.assetUrl);
    const approvals = await approvalDb.getApprovalsByAssetUrls(assetUrls);

    // Build a map of assetUrl -> approval status
    const approvalMap: Record<string, any> = {};
    for (const approval of approvals) {
      approvalMap[approval.assetUrl] = {
        status: approval.status,
        reviewedBy: approval.reviewedBy,
        feedback: approval.feedback,
        updatedAt: approval.updatedAt,
      };
    }

    // Combine batch assets with their approval status
    const assetsWithStatus = batch.assets.map(asset => ({
      ...asset,
      approval: approvalMap[asset.assetUrl] || { status: 'pending' },
    }));

    // Calculate summary
    const reviewed = assetsWithStatus.filter(a => a.approval.status !== 'pending').length;
    const approved = assetsWithStatus.filter(a => a.approval.status === 'approved').length;
    const needsChanges = assetsWithStatus.filter(a => a.approval.status === 'needs_changes').length;
    const rejected = assetsWithStatus.filter(a => a.approval.status === 'rejected').length;

    res.json({
      batchId: batch.batchId,
      status: batch.status,
      note: batch.note,
      createdAt: batch.createdAt,
      assets: assetsWithStatus,
      summary: {
        total: batch.assets.length,
        reviewed,
        approved,
        needsChanges,
        rejected,
        pending: batch.assets.length - reviewed,
      },
    });
  } catch (error: any) {
    console.error("Error fetching batch review:", error.message);
    res.status(500).json({ error: "Failed to fetch batch review" });
  }
});

/**
 * @route POST /batch-review/:batchId/review
 * @desc Submit a review decision for a single asset in the batch
 * @access Public (secured by UUID)
 */
batchReviewPublicRouter.post("/:batchId/review", async (req: Request, res: Response) => {
  const { batchId } = req.params;
  const { assetUrl, decision, reviewerName, feedback } = req.body;

  if (!assetUrl || !decision || !reviewerName) {
    return res.status(400).json({ error: "Missing required fields: assetUrl, decision, reviewerName" });
  }

  if (!['approved', 'needs_changes', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "Invalid decision. Must be: approved, needs_changes, or rejected" });
  }

  try {
    // Verify batch exists
    const batch = await batchReviewDb.getBatchReview(batchId);
    if (!batch) {
      return res.status(404).json({ error: "Batch review not found" });
    }

    // Verify asset belongs to this batch
    const batchAsset = batch.assets.find(a => a.assetUrl === assetUrl);
    if (!batchAsset) {
      return res.status(400).json({ error: "Asset not found in this batch" });
    }

    // Update individual approval
    const updatedApproval = await approvalDb.updateApprovalStatus(
      assetUrl,
      decision,
      reviewerName,
      feedback
    );

    // Trigger auto-revision if needs_changes — pass batchId so revision goes to the batch page
    if (decision === 'needs_changes' && feedback && updatedApproval) {
      // Fire and forget — don't block the response
      triggerAutoRevision(updatedApproval, feedback, batchId).catch(err => {
        console.error('Error triggering auto-revision from batch review:', err);
      });
    }

    // Recalculate batch status
    const assetUrls = batch.assets.map(a => a.assetUrl);
    const allApprovals = await approvalDb.getApprovalsByAssetUrls(assetUrls);
    const approvalStatusMap: Record<string, string> = {};
    for (const a of allApprovals) {
      approvalStatusMap[a.assetUrl] = a.status;
    }

    const totalAssets = batch.assets.length;
    const reviewed = batch.assets.filter(a => {
      const s = approvalStatusMap[a.assetUrl];
      return s && s !== 'pending';
    }).length;
    const approvedCount = batch.assets.filter(a => approvalStatusMap[a.assetUrl] === 'approved').length;
    const needsChangesCount = batch.assets.filter(a => approvalStatusMap[a.assetUrl] === 'needs_changes').length;
    const rejectedCount = batch.assets.filter(a => approvalStatusMap[a.assetUrl] === 'rejected').length;

    const newBatchStatus = reviewed >= totalAssets ? 'completed' : reviewed > 0 ? 'partial' : 'pending';
    await batchReviewDb.updateBatchStatus(batchId, newBatchStatus);

    // Update Slack message with progress
    if (batch.slackMessageTs && batch.slackChannel) {
      const customerFrontendUrl = process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174";
      const reviewPageUrl = `${customerFrontendUrl}/batch-review/${batchId}`;

      try {
        await updateBatchReviewMessage({
          channel: batch.slackChannel,
          messageTs: batch.slackMessageTs,
          totalAssets,
          reviewed,
          approved: approvedCount,
          needsChanges: needsChangesCount,
          rejected: rejectedCount,
          reviewPageUrl,
          isComplete: newBatchStatus === 'completed',
        });
      } catch (slackErr) {
        console.error('Error updating Slack batch review message:', slackErr);
      }
    }

    res.json({
      success: true,
      batchStatus: newBatchStatus,
      summary: {
        total: totalAssets,
        reviewed,
        approved: approvedCount,
        needsChanges: needsChangesCount,
        rejected: rejectedCount,
        pending: totalAssets - reviewed,
      },
    });
  } catch (error: any) {
    console.error("Error submitting batch review:", error.message);
    res.status(500).json({ error: "Failed to submit review", details: error.message });
  }
});
