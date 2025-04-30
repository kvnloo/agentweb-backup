import express from 'express';
import { getApiDocs } from '../controllers/api';

const router = express.Router();

/**
 * @route   GET /api/docs/api
 * @desc    Get API documentation
 * @access  Public
 */
router.get('/', getApiDocs);

export default router; 