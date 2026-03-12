import express, { Request, Response } from 'express';
import { crmDb } from '../services/db';

const router = express.Router();

// GET /api/crm/public/lists/:listId/leads/:leadId/group-email-status
router.get('/lists/:listId/leads/:leadId/group-email-status', async (req: Request, res: Response) => {
  try {
    const { listId, leadId } = req.params;
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';

    if (!email) {
      return res.status(400).json({ message: 'Email query parameter is required' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if ((lead.email || '').toLowerCase() !== email) {
      return res.status(403).json({ message: 'Email does not match lead record' });
    }

    return res.json({
      unsubscribed: lead.unsubscribedFromGroupEmail === true,
    });
  } catch (error) {
    console.error('Error checking group email status:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/crm/public/lists/:listId/leads/:leadId/group-email-unsubscribe
router.post('/lists/:listId/leads/:leadId/group-email-unsubscribe', async (req: Request, res: Response) => {
  try {
    const { listId, leadId } = req.params;
    const { email, feedback } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if ((lead.email || '').toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(403).json({ message: 'Email does not match lead record' });
    }

    await crmDb.updateLead(listId, leadId, {
      unsubscribedFromGroupEmail: true,
      unsubscribedFromGroupEmailAt: new Date().toISOString(),
    });

    if (feedback) {
      console.log(`Unsubscribe feedback from ${email} (list: ${listId}): ${feedback}`);
    }

    return res.json({ message: 'Successfully unsubscribed' });
  } catch (error) {
    console.error('Error unsubscribing from group email:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/crm/public/lists/:listId/leads/:leadId/group-email-resubscribe
router.post('/lists/:listId/leads/:leadId/group-email-resubscribe', async (req: Request, res: Response) => {
  try {
    const { listId, leadId } = req.params;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const lead = await crmDb.getLeadById(listId, leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if ((lead.email || '').toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(403).json({ message: 'Email does not match lead record' });
    }

    await crmDb.updateLead(listId, leadId, {
      unsubscribedFromGroupEmail: false,
    });

    return res.json({ message: 'Successfully resubscribed' });
  } catch (error) {
    console.error('Error resubscribing to group email:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/crm/public/lists/:listId/capture
// Public lead capture endpoint for landing page forms
const captureRateLimitMap = new Map<string, number[]>();

router.post('/lists/:listId/capture', async (req: Request, res: Response) => {
  try {
    const { listId } = req.params;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    // Rate limit: 10 captures per IP per minute
    const now = Date.now();
    const timestamps = captureRateLimitMap.get(ip) || [];
    const recent = timestamps.filter(t => now - t < 60_000);
    if (recent.length >= 10) {
      return res.status(429).json({ message: 'Rate limit exceeded. Try again later.' });
    }
    recent.push(now);
    captureRateLimitMap.set(ip, recent);

    // Verify list exists and has public access enabled
    const list = await crmDb.getLeadListById(listId);
    if (!list) {
      return res.status(404).json({ message: 'List not found' });
    }
    if (!list.publicAccessEnabled) {
      return res.status(403).json({ message: 'Public access is not enabled for this list' });
    }

    const { email, firstName, lastName, company, phone, message } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ message: 'Email is required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    const lead = await crmDb.createLead(listId, {
      email: email.trim().toLowerCase(),
      firstName: firstName || '',
      lastName: lastName || '',
      company: company || '',
      phone: phone || '',
      notes: message || '',
      status: 'new',
    });

    return res.status(201).json({ success: true, leadId: lead.leadId });
  } catch (error: any) {
    // Handle duplicate email gracefully
    if (error.message?.includes('already exists')) {
      return res.status(409).json({ success: true, message: 'Lead already captured' });
    }
    console.error('Error capturing lead:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
