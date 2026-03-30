import express from 'express';
import { getUserGuide } from '../controllers/user-guide';
import { getUserGuideSyncStatus, syncUserGuide } from '../services/notionService';
import { authenticateToken, isAdmin } from '../middleware/auth';

const router = express.Router();

/**
 * @route   GET /api/docs/user-guide
 * @desc    Get user guide data for customer portal
 * @access  Public
 */
router.get('/', getUserGuide);

/**
 * @route   GET /api/docs/user-guide/sync-status
 * @desc    Get sync status between dev and prod user guide Notion pages
 * @access  Admin only
 */
router.get('/sync-status', authenticateToken, isAdmin, async (req, res) => {
  try {
    const status = await getUserGuideSyncStatus();
    res.status(200).json({ success: true, data: status });
  } catch (error) {
    console.error('Error getting user guide sync status:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting sync status',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * @route   POST /api/docs/user-guide/sync
 * @desc    Sync user guide between dev and prod Notion pages
 * @access  Admin only
 */
router.post('/sync', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { direction } = req.body;

    if (!direction || (direction !== 'dev-to-prod' && direction !== 'prod-to-dev')) {
      return res.status(400).json({
        success: false,
        message: 'direction must be "dev-to-prod" or "prod-to-dev"',
      });
    }

    const isDev = process.env.NODE_ENV === 'development';
    const allowedDirection = isDev ? 'dev-to-prod' : 'prod-to-dev';
    if (direction !== allowedDirection) {
      return res.status(400).json({
        success: false,
        message: `In ${isDev ? 'dev' : 'prod'} environment, only "${allowedDirection}" sync is allowed`,
      });
    }

    const result = await syncUserGuide(direction);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('Error syncing user guide:', error);
    res.status(500).json({
      success: false,
      message: 'Error syncing user guide',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
