import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { testAccountsDb } from '../services/db';

const router = express.Router();

router.use(authenticateToken);

function extractDomain(siteUrl: string): string {
  const url = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
  return new URL(url).hostname.replace(/^www\./, '');
}

// GET /api/test-accounts — list all test accounts for the authenticated user
router.get('/', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const accounts = await testAccountsDb.getByUserId(userId);
    const masked = accounts.map((a) => ({ ...a, password: '••••••••' }));
    res.json({ accounts: masked });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch test accounts' });
  }
});

// GET /api/test-accounts/:accountId — get single account with full password (for use by Emma)
router.get('/:accountId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const account = await testAccountsDb.getById(req.params.accountId);
    if (!account || account.userId !== userId) return res.status(404).json({ error: 'Test account not found' });
    res.json({ account });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch test account' });
  }
});

// POST /api/test-accounts — create a new test account
router.post('/', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { siteUrl, email, password, notes, source } = req.body;

    if (!siteUrl || typeof siteUrl !== 'string') {
      return res.status(400).json({ error: 'siteUrl is required' });
    }
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'password is required' });
    }

    let domain: string;
    try {
      domain = extractDomain(siteUrl);
    } catch {
      return res.status(400).json({ error: 'siteUrl must be a valid URL' });
    }

    const account = await testAccountsDb.create(userId, {
      domain,
      siteUrl,
      email,
      password,
      notes,
      source: source ?? 'manual',
    });
    res.status(201).json({ account: { ...account, password: '••••••••' } });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create test account' });
  }
});

// PUT /api/test-accounts/:accountId — update a test account
router.put('/:accountId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const existing = await testAccountsDb.getById(req.params.accountId);
    if (!existing || existing.userId !== userId) return res.status(404).json({ error: 'Test account not found' });

    const { email, password, notes, siteUrl } = req.body;
    const updates: any = {};
    if (email !== undefined) updates.email = email;
    if (password !== undefined) updates.password = password;
    if (notes !== undefined) updates.notes = notes;
    if (siteUrl !== undefined) updates.siteUrl = siteUrl;

    const updated = await testAccountsDb.update(req.params.accountId, updates);
    res.json({ account: updated ? { ...updated, password: '••••••••' } : null });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update test account' });
  }
});

// DELETE /api/test-accounts/:accountId — delete a test account
router.delete('/:accountId', async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const existing = await testAccountsDb.getById(req.params.accountId);
    if (!existing || existing.userId !== userId) return res.status(404).json({ error: 'Test account not found' });

    await testAccountsDb.delete(req.params.accountId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete test account' });
  }
});

export default router;
