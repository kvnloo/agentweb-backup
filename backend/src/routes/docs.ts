import express from 'express';
import guideRoutes from './guide';
import releaseRoutes from './release';
import apiDocsRoutes from './api-docs';

const router = express.Router();

/**
 * Documentation Routes
 * All routes are prefixed with /api/docs
 */
router.use('/guide', guideRoutes);
router.use('/release', releaseRoutes);
router.use('/api', apiDocsRoutes);

export default router; 