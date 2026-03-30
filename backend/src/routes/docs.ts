import express from 'express';
import releaseRoutes from './release';
import apiDocsRoutes from './api-docs';
import userGuideRoutes from './user-guide';
import { getUserReleaseNotes } from '../controllers/docsController';

const router = express.Router();

/**
 * Documentation Routes
 * All routes are prefixed with /api/docs
 */
router.use('/release', releaseRoutes);
router.use('/api', apiDocsRoutes);
router.use('/user-guide', userGuideRoutes);

// Add the new route for user release notes
router.get('/user-release', getUserReleaseNotes);

export default router; 