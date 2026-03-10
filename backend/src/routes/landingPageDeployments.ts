/**
 * Landing Page Deployment routes.
 * Handles deployment approval flow: request approval via Slack → approve/reject → Vercel promote.
 */
import express from 'express';
import { vercelService } from '../services/vercelService';
import { approvalDb } from '../services/approvalDb';

const router = express.Router();

/**
 * GET / — List deployments for a Vercel project
 */
router.get('/', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ message: 'projectId query parameter is required' });
    }

    const deployments = await vercelService.listDeployments(projectId);
    res.json(deployments);
  } catch (error: any) {
    console.error('Error listing deployments:', error);
    res.status(500).json({ message: error.message || 'Failed to list deployments' });
  }
});

/**
 * POST /request-approval — Send a Slack approval request for a landing page deployment
 */
router.post('/request-approval', async (req, res) => {
  try {
    const { deploymentUrl, projectName, slackChannel, slackChannelName, note } = req.body;
    const user = (req as any).user;

    if (!deploymentUrl) {
      return res.status(400).json({ message: 'deploymentUrl is required' });
    }
    if (!slackChannel) {
      return res.status(400).json({ message: 'slackChannel is required' });
    }

    // Import Slack service dynamically to avoid circular deps
    const { getSlackClient } = await import('../services/slackService');
    const slackClient = getSlackClient();

    if (!slackClient) {
      return res.status(503).json({ message: 'Slack client not available' });
    }

    // Send Slack message with approval buttons
    const result = await slackClient.chat.postMessage({
      channel: slackChannel,
      text: `🚀 Landing Page Approval Request: ${projectName || 'Landing Page'}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*🚀 Landing Page Deployment — Approval Required*\n\n*Project:* ${projectName || 'Landing Page'}\n*Preview URL:* <${deploymentUrl}|View Preview>${note ? `\n*Note:* ${note}` : ''}\n*Requested by:* ${user?.email || 'Unknown'}`,
          },
        },
        { type: 'divider' },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Approve & Deploy', emoji: true },
              style: 'primary',
              action_id: 'approve_landing_page',
              value: JSON.stringify({ deploymentUrl, projectName }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔶 Request Changes', emoji: true },
              action_id: 'request_changes_landing_page',
              value: JSON.stringify({ deploymentUrl, projectName }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ Reject', emoji: true },
              style: 'danger',
              action_id: 'reject_landing_page',
              value: JSON.stringify({ deploymentUrl, projectName }),
            },
          ],
        },
      ],
    });

    // Store approval record in DynamoDB
    const approval = await approvalDb.createApproval({
      assetUrl: deploymentUrl,
      filename: projectName || 'Landing Page',
      assetType: 'html',
      userId: user?.userId || 'unknown',
      slackChannel,
      slackChannelName: slackChannelName || slackChannel,
      slackMessageTs: result.ts || null,
      note,
    });

    res.status(201).json({
      message: 'Approval request sent to Slack',
      approval,
      slackMessageTs: result.ts,
    });
  } catch (error: any) {
    console.error('Error requesting landing page approval:', error);
    res.status(500).json({ message: error.message || 'Failed to send approval request' });
  }
});

/**
 * POST /approve — Approve a landing page deployment and promote to production via Vercel
 */
router.post('/approve', async (req, res) => {
  try {
    const { deploymentUrl } = req.body;
    const user = (req as any).user;

    if (!deploymentUrl) {
      return res.status(400).json({ message: 'deploymentUrl is required' });
    }

    // Check approval exists
    const approval = await approvalDb.getApproval(deploymentUrl);
    if (!approval) {
      return res.status(404).json({ message: 'Approval record not found' });
    }

    // Promote to production via Vercel API
    try {
      await vercelService.promoteToProduction(deploymentUrl);
    } catch (vercelError: any) {
      console.error('Vercel promotion failed:', vercelError);
      return res.status(500).json({ message: `Failed to promote deployment: ${vercelError.message}` });
    }

    // Update approval status
    await approvalDb.updateApprovalStatus(
      deploymentUrl,
      'approved',
      user?.email || 'unknown',
      undefined
    );

    res.json({ message: 'Landing page approved and promoted to production' });
  } catch (error: any) {
    console.error('Error approving landing page:', error);
    res.status(500).json({ message: error.message || 'Failed to approve deployment' });
  }
});

/**
 * POST /reject — Reject a landing page deployment with feedback
 */
router.post('/reject', async (req, res) => {
  try {
    const { deploymentUrl, feedback } = req.body;
    const user = (req as any).user;

    if (!deploymentUrl) {
      return res.status(400).json({ message: 'deploymentUrl is required' });
    }

    // Check approval exists
    const approval = await approvalDb.getApproval(deploymentUrl);
    if (!approval) {
      return res.status(404).json({ message: 'Approval record not found' });
    }

    // Update approval status — do NOT promote
    await approvalDb.updateApprovalStatus(
      deploymentUrl,
      'rejected',
      user?.email || 'unknown',
      feedback
    );

    res.json({ message: 'Landing page deployment rejected', feedback });
  } catch (error: any) {
    console.error('Error rejecting landing page:', error);
    res.status(500).json({ message: error.message || 'Failed to reject deployment' });
  }
});

export default router;
