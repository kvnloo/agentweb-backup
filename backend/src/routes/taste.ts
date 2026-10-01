import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth';
import {
  MAX_TASTE_ITEMS,
  TASTE_SURFACES,
  TasteFeedbackNotFoundError,
  TasteProviderError,
  TasteSourceAccessError,
  TasteValidationError,
  tasteProfileService,
} from '../services/tasteProfileService';
import { getLandingPage } from '../services/v0Service';

const router = express.Router();

router.use(authenticateToken);

const importLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // authenticateToken runs first, so imports are throttled per account rather than
  // per shared office/VPN IP.
  keyGenerator: (req: any) => String(req.user.userId),
  message: { error: 'Too many taste imports. Try again shortly.' },
});

const feedbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: any) => String(req.user.userId),
  message: { error: 'Too many Taste feedback actions. Try again shortly.' },
});

function userId(req: any): string {
  return req.user.userId;
}

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  label = 'request body'
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TasteValidationError(`${label} must be an object`);
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowedSet.has(key)) {
      throw new TasteValidationError(`unsupported ${label} field: ${key}`);
    }
  }
}

function sendTasteError(res: express.Response, error: unknown) {
  if (error instanceof TasteValidationError) {
    return res.status(400).json({ error: error.message });
  }
  if (error instanceof TasteSourceAccessError) {
    return res.status(404).json({ error: 'Connected source not found' });
  }
  if (error instanceof TasteFeedbackNotFoundError) {
    return res.status(404).json({ error: error.message });
  }
  if (error instanceof TasteProviderError) {
    return res.status(502).json({ error: error.message });
  }
  console.error('[taste] request failed', error instanceof Error ? error.name : 'unknown_error');
  return res.status(500).json({ error: 'Taste profile operation failed' });
}

// Import is read-only against X. The caller supplies only an AgentWeb connected-account
// ID; OAuth access/refresh tokens never cross this API boundary.
router.post('/import/x', importLimiter, async (req, res) => {
  try {
    assertExactKeys(req.body, ['accountId']);
    const profile = await tasteProfileService.importXBookmarks(userId(req), req.body.accountId);
    return res.status(201).json({ profile });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

// Generic import is deliberately data-only in v1. URLs may be supplied as metadata,
// but the server never fetches them. That keeps the seam useful for design dumps,
// bookmark exports, Figma/Pinterest-like collections, etc. without creating an SSRF
// primitive or silently collecting content the user did not submit.
router.post('/import/collection', importLimiter, async (req, res) => {
  try {
    assertExactKeys(req.body, ['collectionId', 'items']);
    if (!Array.isArray(req.body.items)) {
      throw new TasteValidationError('items must be an array');
    }
    if (req.body.items.length > MAX_TASTE_ITEMS) {
      throw new TasteValidationError(`items supports at most ${MAX_TASTE_ITEMS} entries`);
    }

    const profile = await tasteProfileService.importCollection(
      userId(req),
      req.body.items,
      req.body.collectionId
    );
    return res.status(201).json({ profile });
  } catch (error) {
    return sendTasteError(res, error);
  }
});



router.get('/settings', async (req, res) => {
  try {
    const settings = await tasteProfileService.getSettings(userId(req));
    return res.json({ settings });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.put('/settings', async (req, res) => {
  try {
    assertExactKeys(req.body, ['surfaces']);
    const settings = await tasteProfileService.updateSettings(userId(req), req.body.surfaces);
    return res.json({ settings });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.get('/surfaces', (_req, res) => {
  return res.json({
    surfaces: TASTE_SURFACES,
    intensities: ['off', 'subtle', 'strong'],
  });
});

router.get('/application', async (req, res) => {
  try {
    const application = await tasteProfileService.getApplication(
      userId(req),
      req.query.surface,
      req.query.intensity
    );
    return res.json({ application });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.post('/apply', importLimiter, async (req, res) => {
  try {
    assertExactKeys(req.body, ['surface', 'intensity', 'prompt']);
    const result = await tasteProfileService.applyToPrompt(
      userId(req),
      req.body.surface,
      req.body.prompt,
      req.body.intensity
    );
    return res.json(result);
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.post('/feedback', feedbackLimiter, async (req, res) => {
  try {
    // Receipt/provenance is NEVER caller-supplied. Resolve the artifact through its
    // owner-scoped store and copy the receipt that was persisted at generation time.
    assertExactKeys(req.body, ['artifactType', 'artifactId', 'direction']);
    if (req.body.artifactType !== 'landing_page') {
      throw new TasteValidationError('artifactType must be landing_page');
    }
    if (typeof req.body.artifactId !== 'string' || !req.body.artifactId.trim()) {
      throw new TasteValidationError('artifactId is required');
    }
    if (!['more', 'less', 'ignore'].includes(req.body.direction)) {
      throw new TasteValidationError('direction must be more, less, or ignore');
    }

    const artifact = await getLandingPage(req.body.artifactId.trim(), userId(req));
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    if (!artifact.tasteReceipt) {
      return res.status(409).json({ error: 'Artifact does not have Taste provenance' });
    }

    const feedback = await tasteProfileService.recordFeedback(
      userId(req),
      'landing_page',
      artifact.id,
      req.body.direction,
      artifact.tasteReceipt
    );
    return res.status(201).json({ feedback });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.get('/feedback', async (req, res) => {
  try {
    const feedback = await tasteProfileService.listFeedback(
      userId(req),
      req.query.artifactId
    );
    return res.json({ feedback });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.post('/feedback/:eventId/reverse', feedbackLimiter, async (req, res) => {
  try {
    const feedback = await tasteProfileService.reverseFeedback(
      userId(req),
      req.params.eventId
    );
    return res.json({ feedback });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.get('/profile', async (req, res) => {
  try {
    const profile = await tasteProfileService.getProfile(userId(req));
    return res.json({ profile });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

router.delete('/profile', async (req, res) => {
  try {
    const deleted = await tasteProfileService.deleteProfile(userId(req));
    return res.json({ success: true, deleted });
  } catch (error) {
    return sendTasteError(res, error);
  }
});

export default router;
