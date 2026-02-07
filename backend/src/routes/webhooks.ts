import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';

const router = express.Router();

// Resend webhook endpoint
router.post('/resend', async (req: express.Request, res: express.Response) => {
  try {
    // Initialize webhook service if not already done
    await webhookService.initialize();

    // Use the parsed body from Express (since we can't easily get raw body with signature verification)
    const payload = JSON.stringify(req.body);
    const headers = req.headers as IncomingMessage['headers'] & WebhookRequiredHeaders;

    // Verify webhook signature
    const event = webhookService.verifyWebhook(payload, headers);

    console.log(`Received Resend webhook: ${event.type} for email ${event.data.email_id}`);

    // Extract email domain
    // For email.received events, extract from data.to[0] (the recipient is the domain)
    // For all other events, extract from data.from (the sender is the domain)
    let emailDomain: string;
    if (event.type === 'email.received') {
      const recipient = Array.isArray(event.data.to) ? event.data.to[0] : event.data.to;
      emailDomain = webhookService.extractEmailDomain(recipient);
    } else {
      emailDomain = webhookService.extractEmailDomain(event.data.from);
    }

    // Generate deterministic event ID for deduplication
    const eventId = webhookService.generateEventId(event);

    // Check if event already exists (deduplication)
    const eventExists = await emailEventsDb.eventExists(eventId);
    if (eventExists) {
      console.log(`Event already exists, skipping duplicate: ${eventId}`);
      return res.status(200).json({ 
        message: 'Event already processed (duplicate)',
        eventId: eventId 
      });
    }

    // Store the event in the database
    const emailEvent = await emailEventsDb.addEmailEvent(event, emailDomain, eventId);
    try {
      await leadListAlertService.notifyForEmailEvent(emailEvent);
    } catch (alertError) {
      console.error('Failed to send lead list alert email:', alertError);
    }

    // Handle specific event types
    switch (event.type) {
      case 'email.delivered':
        console.log(`Email delivered: ${event.data.email_id} to ${event.data.to.join(', ')}`);
        break;
      
      case 'email.bounced':
        console.log(`Email bounced: ${event.data.email_id} - ${event.data.bounce?.reason || 'Unknown reason'}`);
        break;
      
      case 'email.complained':
        console.log(`Email complaint: ${event.data.email_id} - ${event.data.complaint?.reason || 'Unknown reason'}`);
        break;
      
      case 'email.clicked':
        console.log(`Email clicked: ${event.data.email_id} - Link: ${event.data.click?.link}`);
        break;
      
      case 'email.opened':
        console.log(`Email opened: ${event.data.email_id}`);
        break;
      
      case 'email.received':
        console.log(`Email received: ${event.data.email_id} from ${event.data.from} to ${Array.isArray(event.data.to) ? event.data.to.join(', ') : event.data.to}`);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({ 
      message: 'Webhook processed successfully',
      eventId: emailEvent.eventId,
      emailDomain: emailDomain
    });

  } catch (error: any) {
    console.error('Webhook processing error:', error);
    res.status(400).json({ 
      message: 'Webhook processing failed',
      error: error.message 
    });
  }
});

// Public endpoint for forwarding leads to CRM
router.post('/forward-lead', async (req: express.Request, res: express.Response) => {
  // Set CORS headers to allow all origins for this endpoint
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract listId from body
  const { listId } = req.body;

  if (!listId) {
    return res.status(400).json({
      success: false,
      message: 'listId is required in request body'
    });
  }

  // Get lead list and verify public access is enabled
  const leadList = await crmDb.getLeadListById(listId);
  if (!leadList) {
    return res.status(404).json({
      success: false,
      message: 'Lead list not found'
    });
  }

  // Public access must be explicitly enabled (true)
  // Default behavior: disabled
  if (leadList.publicAccessEnabled !== true) {
    return res.status(403).json({
      success: false,
      message: 'Public access is not enabled for this lead list. Please enable it in the CRM settings.'
    });
  }

  try {

    // Extract lead data from request body
    const {
      email,
      firstName,
      lastName,
      phone,
      company,
      title,
      notes,
      linkedin,
      source,
      customFields
    } = req.body;

    // Validate required field (email)
    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Prepare lead data
    const leadData: any = {
      email: email.trim(),
      firstName: firstName?.trim() || '',
      lastName: lastName?.trim() || '',
      phone: phone?.trim() || '',
      company: company?.trim() || '',
      title: title?.trim() || '',
      notes: notes?.trim() || '',
      linkedin: linkedin?.trim() || '',
    };

    // Add custom fields with source and createdAt tracking
    const mergedCustomFields: Record<string, any> = {
      ...(customFields && typeof customFields === 'object' ? customFields : {}),
      // Add source field (from request or default to 'api')
      source: source?.trim() || customFields?.source || 'api',
      // Add timestamp when lead was forwarded
      forwardedAt: new Date().toISOString(),
    };

    leadData.customFields = mergedCustomFields;

    // Create the lead
    const lead = await crmDb.createLead(leadList.listId, leadData);

    // Auto-create initial drafts for newly forwarded leads
    let autoDraftStatus: 'created' | 'failed' | undefined;
    let autoDraftError: string | undefined;
    if (leadList.autoDraftEnabled === true) {
      try {
        const sourceLabel = String(mergedCustomFields.source || 'API form submission');
        const configuredInstruction = typeof leadList.autoDraftInstruction === 'string'
          ? leadList.autoDraftInstruction.trim()
          : '';
        const autoDraftInstruction = `Create an initial outreach message for this new lead from ${sourceLabel}. Keep it concise, personalized, and include a clear next step.${configuredInstruction ? `\n\nAdditional instruction:\n${configuredInstruction}` : ''}`;
        const autoDraftSessionId = `auto_draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const autoDraftResult = await agentModeService.updateEmailDraftForLead(
          leadList.listId,
          lead.leadId,
          autoDraftInstruction,
          autoDraftSessionId,
          leadList.userId,
          'text'
        );
        if (autoDraftResult?.success) {
          autoDraftStatus = 'created';
        } else {
          autoDraftStatus = 'failed';
          autoDraftError = autoDraftResult?.error || autoDraftResult?.message || 'Unknown auto-draft error';
        }
      } catch (draftError: any) {
        autoDraftStatus = 'failed';
        autoDraftError = draftError?.message || 'Unknown auto-draft error';
      }
    }

    // Trigger api.lead_added alert if configured
    try {
      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        leadList,
        lead,
        'api.lead_added',
        {
          source: mergedCustomFields.source,
          forwardedAt: mergedCustomFields.forwardedAt,
          company: leadData.company,
          phone: leadData.phone,
          ...(autoDraftStatus ? { autoDraftStatus } : {}),
          ...(autoDraftError ? { autoDraftError } : {}),
        },
        new Date().toISOString()
      );
    } catch (alertError) {
      console.error('Failed to send api.lead_added alert:', alertError);
      // Don't fail the request if alert fails
    }

    res.status(201).json({
      success: true,
      message: 'Lead forwarded successfully',
      leadId: lead.leadId,
      listId: leadList.listId
    });

  } catch (error: any) {
    console.error('Lead forwarding error:', error);

    // Trigger api.lead_failed alert if configured
    try {
      await leadListAlertService.notifyLeadListOwnerIfConfigured(
        leadList,
        {
          leadId: 'failed',
          email: req.body.email || 'unknown',
          firstName: req.body.firstName || '',
          lastName: req.body.lastName || '',
        },
        'api.lead_failed',
        {
          error: error.message || 'Unknown error',
          source: req.body.source || req.body.customFields?.source || 'api',
          email: req.body.email || 'unknown',
        },
        new Date().toISOString()
      );
    } catch (alertError) {
      console.error('Failed to send api.lead_failed alert:', alertError);
    }

    // Handle duplicate email error - return success to prevent retries
    if (error.message?.includes('already exists') || error.message?.includes('duplicate')) {
      return res.status(200).json({
        success: true,
        message: 'Lead already exists in the list',
        duplicate: true
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to forward lead'
    });
  }
});

export default router;
