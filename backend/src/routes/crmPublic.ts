import express, { Request, Response } from 'express';
import { crmDb } from '../services/db';
import {
  onPublicFormSubmitted,
  onPublicPageVisited,
} from '../services/contactCaptureHooks';
import { PUBLIC_LOGGABLE_EVENT_TYPES } from '../services/contactEventsDb';

const router = express.Router();

// Defensive bounds — a public endpoint is a spam target, so cap payload
// sizes and string lengths locally before persisting.
const MAX_EMAIL_LENGTH = 320; // RFC 5321
const MAX_SOURCE_RECORD_ID_LENGTH = 200;
const MAX_PAYLOAD_BYTES = 4096;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/crm/public/events
 * Body: { email, eventType, sourceRecordId, payload? }
 *
 * Logs a public-source activity-timeline event (currently: form.submitted,
 * page.visited). Dedup by sourceRecordId. No auth — anyone with the endpoint
 * can submit, so we only accept a narrow whitelist of event types and bound
 * every input field. Use this from landing-page form handlers and identified-
 * visitor beacons.
 */
router.post('/events', async (req: Request, res: Response) => {
  try {
    const { email, eventType, sourceRecordId, payload } = req.body ?? {};

    // ---- Validate email ---------------------------------------------------
    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ message: 'email is required' });
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail.length > MAX_EMAIL_LENGTH) {
      return res.status(400).json({ message: 'email exceeds max length' });
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({ message: 'email is malformed' });
    }

    // ---- Validate eventType (whitelist) -----------------------------------
    if (typeof eventType !== 'string' || !eventType) {
      return res.status(400).json({ message: 'eventType is required' });
    }
    if (!PUBLIC_LOGGABLE_EVENT_TYPES.has(eventType)) {
      return res.status(400).json({
        message: `eventType not allowed on public endpoint. Allowed: ${Array.from(
          PUBLIC_LOGGABLE_EVENT_TYPES
        ).join(', ')}`,
      });
    }

    // ---- Validate sourceRecordId ------------------------------------------
    if (typeof sourceRecordId !== 'string' || !sourceRecordId.trim()) {
      return res.status(400).json({ message: 'sourceRecordId is required' });
    }
    if (sourceRecordId.length > MAX_SOURCE_RECORD_ID_LENGTH) {
      return res.status(400).json({ message: 'sourceRecordId exceeds max length' });
    }

    // ---- Validate payload (optional object, size-capped) ------------------
    let normalisedPayload: Record<string, unknown> | undefined;
    if (payload !== undefined && payload !== null) {
      if (
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        (payload as any).constructor !== Object
      ) {
        return res.status(400).json({ message: 'payload must be a plain object' });
      }
      const serialised = JSON.stringify(payload);
      if (serialised.length > MAX_PAYLOAD_BYTES) {
        return res.status(400).json({
          message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
        });
      }
      normalisedPayload = payload as Record<string, unknown>;
    }

    // ---- Dispatch to the right capture hook -------------------------------
    let result;
    if (eventType === 'form.submitted') {
      result = await onPublicFormSubmitted({
        email: trimmedEmail,
        sourceRecordId,
        formName:
          typeof normalisedPayload?.formName === 'string'
            ? (normalisedPayload.formName as string)
            : null,
        payload: normalisedPayload,
      });
    } else {
      // Guarded above by the whitelist — only page.visited reaches here.
      result = await onPublicPageVisited({
        email: trimmedEmail,
        sourceRecordId,
        url:
          typeof normalisedPayload?.url === 'string'
            ? (normalisedPayload.url as string)
            : null,
        referrer:
          typeof normalisedPayload?.referrer === 'string'
            ? (normalisedPayload.referrer as string)
            : null,
        payload: normalisedPayload,
      });
    }

    if (!result) {
      return res.status(500).json({ message: 'Failed to record event' });
    }

    return res.status(result.deduplicated ? 200 : 201).json({
      recorded: true,
      deduplicated: result.deduplicated,
      eventId: result.event.eventId,
      eventType: result.event.eventType,
    });
  } catch (error) {
    console.error('Error logging public CRM event:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

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

    const { isDoNotContact } = await import('../utils/leadContactStatus');
    return res.json({
      unsubscribed: lead.unsubscribedFromGroupEmail === true || isDoNotContact(lead),
      contactStatus: lead.contactStatus || (lead.unsubscribedFromGroupEmail === true ? 'unsubscribed' : 'active'),
      contactStatusReason: lead.contactStatusReason || undefined,
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

    const now = new Date().toISOString();
    await crmDb.updateLead(listId, leadId, {
      unsubscribedFromGroupEmail: true,
      unsubscribedFromGroupEmailAt: now,
      contactStatus: 'unsubscribed',
      contactStatusReason: 'opted-out',
      contactStatusNote: feedback || undefined,
      contactStatusUpdatedAt: now,
      contactStatusUpdatedBy: 'lead-self',
    });

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
      contactStatus: 'active',
      contactStatusReason: null,
      contactStatusNote: null,
      contactStatusUpdatedAt: new Date().toISOString(),
      contactStatusUpdatedBy: 'lead-self',
    });

    return res.json({ message: 'Successfully resubscribed' });
  } catch (error) {
    console.error('Error resubscribing to group email:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
