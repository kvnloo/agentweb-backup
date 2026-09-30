import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth';
import {
  MAX_TASTE_ITEMS,
  TasteProviderError,
  TasteSourceAccessError,
  TasteValidationError,
  tasteProfileService,
} from '../services/tasteProfileService';

const router = express.Router();

router.use(authenticateToken);

const importLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many taste imports. Try again shortly.' },
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
