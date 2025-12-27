import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';

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

export default router;
