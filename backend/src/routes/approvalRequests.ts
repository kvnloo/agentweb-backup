/**
 * Channel-neutral approval requests (ENG-273).
 *
 * `POST /api/slack/send-approval` requires a Slack channel, which made having one a
 * precondition for being asked to approve anything. This is the same request without
 * that assumption: the customer is asked on whichever channel they have connected.
 * The Slack route stays as it is for callers that already use it.
 */
import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { getAssetTypeFromFilename } from '../services/approvalDb';
import {
  requestApproval,
  ApprovalDeliveryFailedError,
  ApprovalForbiddenError,
  ApprovalNotDeliveredError,
} from '../services/approvalRequestService';

const router = express.Router();

router.post('/', authenticateToken, async (req: any, res: any) => {
  try {
    // No `channel` from the body, on purpose: this route has no Slack-entitlement check, and
    // the workspace bot would post wherever it was pointed. It serves customers who are
    // asked on WhatsApp; Slack customers go through /api/slack/send-approval, which checks.
    const { assetUrl, filename, executionId, note } = req.body || {};
    const userId = req.user?.userId;

    if (!assetUrl || !filename) {
      return res.status(400).json({ error: 'Missing required fields: assetUrl, filename' });
    }
    if (!userId) return res.status(401).json({ error: 'User not authenticated' });

    const result = await requestApproval({
      executionId: executionId || '',
      imageUrl: assetUrl,
      filename,
      assetType: getAssetTypeFromFilename(filename),
      userId,
      channel: null,
      note,
      // The new route is strict for everyone: a caller may not replace another account's
      // approval or point at another account's execution.
      enforceOwnership: true,
      typedFailures: true,
    });

    res.json({
      success: true,
      message: 'Approval request sent successfully',
      approvalId: result.approvalId,
      deliveredVia: result.deliveredVia,
    });
  } catch (error: any) {
    if (error instanceof ApprovalNotDeliveredError) {
      // Not a server fault: the account simply has nowhere to be asked. The task engine
      // relies on telling this apart from a 500 to fall back to its no-approval path.
      return res.status(409).json({ success: false, error: error.message, code: 'no_channel' });
    }
    if (error instanceof ApprovalForbiddenError) {
      return res.status(403).json({ success: false, error: error.message, code: 'forbidden' });
    }
    if (error instanceof ApprovalDeliveryFailedError) {
      // The account HAS a channel and the send failed. A different answer from no_channel,
      // on purpose: the task engine treats no_channel as "nobody to ask" and carries on,
      // but a customer who can be reached and was not must have their output held.
      return res.status(502).json({ success: false, error: error.message, code: 'delivery_failed' });
    }
    console.error('[approval-requests] failed:', error?.message || error);
    res.status(500).json({ success: false, error: 'Failed to send approval request' });
  }
});

export default router;
