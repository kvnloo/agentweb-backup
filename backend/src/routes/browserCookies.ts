import { Router } from 'express';
import { authenticateToken } from '../middleware/auth';
import { browserCookieDb } from '../services/db';
import { parseCookieHeader } from '../utils/cookieHeaderParser';

const router = Router();

const DOMAIN_REGEX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

// List manually-imported cookie domains for the current user (metadata only, no values)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const domains = await browserCookieDb.listDomainCookies(userId);
    res.json(domains);
  } catch (error) {
    console.error('Error listing browser cookies:', error);
    res.status(500).json({ error: 'Failed to list saved browser sessions' });
  }
});

// Import a manually-copied session cookie for a domain
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    let { domain, cookieHeader } = req.body;

    if (!domain || !cookieHeader) {
      return res.status(400).json({ error: 'domain and cookieHeader are required' });
    }

    domain = String(domain).toLowerCase().trim();
    if (!DOMAIN_REGEX.test(domain)) {
      return res.status(400).json({
        error: 'Invalid domain name format. Please enter a valid domain (e.g., example.com, sub.example.com)',
        type: 'INVALID_DOMAIN',
      });
    }

    let cookies;
    try {
      cookies = parseCookieHeader(cookieHeader, domain);
    } catch (parseError: any) {
      return res.status(400).json({ error: parseError.message });
    }

    await browserCookieDb.saveDomainCookies(userId, domain, cookies);

    res.status(201).json({ domain, cookieCount: cookies.length });
  } catch (error) {
    console.error('Error saving browser cookies:', error);
    res.status(500).json({ error: 'Failed to save browser session' });
  }
});

// Delete a saved session for a domain
router.delete('/:domain', authenticateToken, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const domain = req.params.domain.toLowerCase().trim();

    await browserCookieDb.deleteDomainCookies(userId, domain);

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting browser cookies:', error);
    res.status(500).json({ error: 'Failed to delete browser session' });
  }
});

export default router;
