import express from 'express';
import releaseRoutes from './release';
import { getUserReleaseNotes } from '../controllers/docsController';

const router = express.Router();

/**
 * Documentation Routes
 * All routes are prefixed with /api/docs
 */
router.use('/release', releaseRoutes);

/**
 * Retired endpoints (ENG-163): the hand-rolled API docs (`/api/docs/api`) and the
 * Notion user-guide sync (`/api/docs/user-guide*`) were removed when docs
 * consolidated on Mintlify (docs.agentweb.pro). They are UI-orphaned; any
 * remaining or cached client gets a definitive 410 Gone.
 */
const legacyDocsGone = (_req: express.Request, res: express.Response) =>
  res.status(410).json({
    success: false,
    message:
      'This documentation endpoint has been retired. Docs now live at https://docs.agentweb.pro',
  });

router.all('/api', legacyDocsGone);
router.all('/user-guide', legacyDocsGone);
router.all('/user-guide/*', legacyDocsGone);

// Add the new route for user release notes
router.get('/user-release', getUserReleaseNotes);

export default router;
