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

export default router;
