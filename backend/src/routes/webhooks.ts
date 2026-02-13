import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb, dripCampaignDb } from '../services/db';

const router = express.Router();

// Helper function to handle drip campaign replies
async function handleDripCampaignReply(event: ResendWebhookEvent, emailDomain: string) {
  try {
    // Extract the sender's email (who replied)
    const replyFromEmail = event.data.from.toLowerCase();

    // Query email events to find the original sent email from this domain to this lead
    const sentEvents = await emailEventsDb.getEventsByEmailDomainAndLeadEmail(emailDomain, replyFromEmail);

    // Look for the most recent 'email.sent' or 'email.delivered' event with drip campaign metadata
    for (const sentEvent of sentEvents) {
      const metadata = sentEvent.data?.tags;

      if (metadata && metadata.campaignId && metadata.enrollmentId) {
        console.log(`Detected reply to drip campaign ${metadata.campaignId}, enrollment ${metadata.enrollmentId}`);

        // Get the campaign to check if stopOnReply is enabled
        const campaign = await dripCampaignDb.getCampaign(metadata.campaignId);
        if (!campaign) {
          console.log(`Campaign ${metadata.campaignId} not found`);
          continue;
        }

        // Check if stopOnReply is enabled
        if (campaign.stopConditions?.stopOnReply) {
          // Get the enrollment
          const enrollment = await dripCampaignDb.getEnrollment(metadata.enrollmentId);
          if (!enrollment) {
            console.log(`Enrollment ${metadata.enrollmentId} not found`);
            continue;
          }

          // Only stop if enrollment is still active
          if (enrollment.status === 'active') {
            console.log(`Stopping enrollment ${metadata.enrollmentId} due to reply`);

            // Update enrollment status to stopped
            await dripCampaignDb.updateEnrollment(metadata.enrollmentId, {
              status: 'stopped',
              stoppedAt: new Date().toISOString(),
              stoppedReason: 'replied'
            });

            // Update campaign stats
            await dripCampaignDb.updateCampaign(metadata.campaignId, {
              'stats.active': (campaign.stats?.active || 1) - 1,
              'stats.stopped': (campaign.stats?.stopped || 0) + 1
            });

            console.log(`Successfully stopped enrollment ${metadata.enrollmentId}`);
          } else {
            console.log(`Enrollment ${metadata.enrollmentId} is already ${enrollment.status}, not stopping`);
          }
        } else {
          console.log(`Campaign ${metadata.campaignId} does not have stopOnReply enabled`);
        }

        // We found and processed the campaign, break out
        break;
      }
    }
  } catch (error) {
    console.error('Error handling drip campaign reply:', error);
    // Don't throw - we don't want to fail the webhook if drip campaign processing fails
  }
}

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
        // Check if this is a reply to a drip campaign email
        await handleDripCampaignReply(event, emailDomain);
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
  // Extract API key from header or body
  const apiKey = req.headers['x-api-key'] as string || req.body.apiKey;

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      message: 'API key is required. Provide it in X-API-Key header or apiKey field in request body.'
    });
  }

  // Verify API key and get lead list
  const leadList = await crmDb.getLeadListByApiKey(apiKey);
  if (!leadList) {
    return res.status(401).json({
      success: false,
      message: 'Invalid API key'
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
