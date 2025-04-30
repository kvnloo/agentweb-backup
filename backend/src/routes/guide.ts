import express from 'express';
import { getGuide } from '../controllers/guide';

const router = express.Router();

/**
 * @route   GET /api/docs/guide
 * @desc    Get guide data
 * @access  Public
 */
router.get('/', getGuide);

export default router; 