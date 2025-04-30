import express from 'express';
import { getReleases } from '../controllers/release';

const router = express.Router();

/**
 * @route   GET /api/docs/release
 * @desc    Get release history data
 * @access  Public
 */
router.get('/', getReleases);

export default router; 