import express from 'express';
import { getUserGuide } from '../controllers/user-guide';

const router = express.Router();

/**
 * @route   GET /api/docs/user-guide
 * @desc    Get user guide data for customer portal
 * @access  Public
 */
router.get('/', getUserGuide);

export default router; 