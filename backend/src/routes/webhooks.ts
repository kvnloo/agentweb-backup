import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';
import { emmaEmailService } from '../services/emmaEmailService';

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

    // Skip CRM event storage and alerts for Emma-related emails
    const eventTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
    const isEmmaEvent = emmaEmailService.isEmmaRelatedEvent(event.data.from || '', eventTo);

    if (!isEmmaEvent) {
      // Store the event in the database
      const emailEvent = await emailEventsDb.addEmailEvent(event, emailDomain, eventId);
      try {
        await leadListAlertService.notifyForEmailEvent(emailEvent);
      } catch (alertError) {
        console.error('Failed to send lead list alert email:', alertError);
      }
    } else {
      console.log(`Skipping CRM event storage for Emma-related email: ${event.data.email_id}`);
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
      
      case 'email.received': {
        const toAddresses = Array.isArray(event.data.to) ? event.data.to : [event.data.to];
        console.log(`Email received: ${event.data.email_id} from ${event.data.from} to ${toAddresses.join(', ')}`);
        if (emmaEmailService.isEmmaEmail(toAddresses)) {
          // Process asynchronously - don't block webhook response
          void (async () => {
            try {
              await emmaEmailService.processInboundEmail({
                emailId: event.data.email_id,
                from: event.data.from,
                to: toAddresses,
                subject: event.data.subject,
              });
            } catch (err) {
              console.error('[EmmaEmail] Failed to process:', err);
            }
          })();
        }
        break;
      }
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).json({
      message: 'Webhook processed successfully',
      eventId: eventId,
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

    // Add custom fields with source tracking
    const incomingCustomFields: Record<string, any> = {
      ...(customFields && typeof customFields === 'object' ? customFields : {}),
      // Add source field (from request or default to 'api')
      source: source?.trim() || customFields?.source || 'api',
    };

    // Check if lead already exists by email - merge instead of dropping
    const existingLead = await crmDb.getLeadByEmail(leadList.listId, email.trim().toLowerCase());

    // Only stamp forwardedAt for new leads; for existing leads, preserve the original timestamp
    const mergedCustomFields: Record<string, any> = existingLead
      ? incomingCustomFields
      : { ...incomingCustomFields, forwardedAt: new Date().toISOString() };

    leadData.customFields = mergedCustomFields;

    let lead: any;
    let isNew = false;
    let isUpdated = false;

    if (existingLead) {
      // Merge new data into existing lead (only overwrite with non-empty values)
      const normalize = (value: any): string => {
        if (value === null || value === undefined) return '';
        return String(value).trim();
      };

      const updates: any = {};
      let changed = false;

      const standardFields = ['firstName', 'lastName', 'phone', 'company', 'title', 'notes', 'linkedin'] as const;
      for (const field of standardFields) {
        const newValue = normalize(leadData[field]);
        if (newValue) {
          const existingValue = normalize(existingLead[field]);
          if (existingValue !== newValue) {
            updates[field] = newValue;
            changed = true;
          }
        }
      }

      // Merge custom fields
      const existingCustomFields = existingLead.customFields || {};
      const mergedCf = { ...existingCustomFields, ...mergedCustomFields };
      if (JSON.stringify(existingCustomFields) !== JSON.stringify(mergedCf)) {
        updates.customFields = mergedCf;
        changed = true;
      }

      if (changed) {
        await crmDb.updateLead(leadList.listId, existingLead.leadId, updates);
        isUpdated = true;
      }

      lead = { ...existingLead, ...updates };
    } else {
      // Create a new lead
      lead = await crmDb.createLead(leadList.listId, leadData);
      isNew = true;
    }

    // Send API response immediately so caller is not blocked
    if (isNew) {
      res.status(201).json({
        success: true,
        message: 'Lead forwarded successfully',
        event: 'lead.created',
        leadId: lead.leadId,
        listId: leadList.listId
      });
    } else if (isUpdated) {
      res.status(200).json({
        success: true,
        message: 'Lead updated successfully',
        event: 'lead.updated',
        leadId: lead.leadId,
        listId: leadList.listId
      });
    } else {
      res.status(200).json({
        success: true,
        message: 'Lead already exists with no changes',
        event: 'lead.unchanged',
        leadId: lead.leadId,
        listId: leadList.listId
      });
    }

    // After response is sent: auto-draft, auto-send, and alert (fire-and-forget, fully awaited internally)
    if (isNew || isUpdated) {
      void (async () => {
        try {
          let autoDraftStatus: string | undefined;
          let autoDraftError: string | undefined;
          let autoSendStatus: string | undefined;

          if (leadList.autoDraftEnabled === true) {
            const sourceLabel = String(mergedCustomFields.source || 'API form submission');
            const configuredInstruction = typeof leadList.autoDraftInstruction === 'string'
              ? leadList.autoDraftInstruction.trim()
              : '';
            const autoDraftInstruction = `Create an initial outreach message for this new lead from ${sourceLabel}. Keep it concise, personalized, and include a clear next step.${configuredInstruction ? `\n\nAdditional instruction:\n${configuredInstruction}` : ''}`;
            const autoDraftSessionId = `auto_draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            try {
              const autoDraftResult = await agentModeService.updateEmailDraftForLead(
                leadList.listId,
                lead.leadId,
                autoDraftInstruction,
                autoDraftSessionId,
                leadList.userId,
                'text'
              );
              if (!autoDraftResult?.success) {
                const errMsg = autoDraftResult?.error || autoDraftResult?.message || 'Unknown auto-draft error';
                console.error('Auto draft creation failed:', errMsg);
                autoDraftStatus = 'failed';
                autoDraftError = errMsg;
              } else {
                autoDraftStatus = 'created';

                // Auto-send the draft if enabled
                if (leadList.autoSendEnabled === true && autoDraftResult?.data?.email) {
                  const draftEmail = autoDraftResult.data.email;
                  const leadEmail = lead.email;

                  if (!leadEmail) {
                    console.error('Auto send skipped: lead has no email address');
                    autoSendStatus = 'skipped_no_email';
                  } else {
                    // Check if an email was already auto-sent to this lead today
                    const freshLead = await crmDb.getLeadById(leadList.listId, lead.leadId);
                    if (freshLead?.lastAutoSendAt) {
                      const lastSendDate = new Date(freshLead.lastAutoSendAt).toDateString();
                      const todayDate = new Date().toDateString();
                      if (lastSendDate === todayDate) {
                        console.log(`Auto send skipped: email already sent today to lead ${lead.leadId} in list ${leadList.listId}`);
                        autoSendStatus = 'skipped_already_sent_today';
                      }
                    }

                    if (!autoSendStatus) {
                      // Resolve sender
                      const sendersResult = await agentModeService.getCrmSenders(leadList.userId);
                      let senderEmail: string | undefined;
                      let senderFromName: string | undefined;

                      if (sendersResult?.success && sendersResult.senders.length > 0) {
                        const sender = (leadList.listSenderId
                          ? sendersResult.senders.find((s: any) => s.id === leadList.listSenderId)
                          : null)
                          || (sendersResult.defaultSenderId
                            ? sendersResult.senders.find((s: any) => s.id === sendersResult.defaultSenderId)
                            : null)
                          || sendersResult.senders[0];

                        if (sender) {
                          senderEmail = sender.email;
                          senderFromName = sender.fromName;
                        }
                      }

                      if (!senderEmail || !senderFromName) {
                        console.error('Auto send skipped: no sender configured for user', leadList.userId);
                        autoSendStatus = 'skipped_no_sender';
                      } else {
                        try {
                          const from = `${senderFromName} <${senderEmail}>`;
                          await resendService.sendEmail({
                            from,
                            to: leadEmail,
                            subject: draftEmail.subject,
                            text: draftEmail.textContent,
                            html: draftEmail.htmlContent,
                          });
                          await crmDb.updateLead(leadList.listId, lead.leadId, { emailDraft: null, lastAutoSendAt: new Date().toISOString() });
                          console.log(`Auto send succeeded for lead ${lead.leadId} in list ${leadList.listId}`);
                          autoSendStatus = 'sent';
                        } catch (sendError: any) {
                          console.error('Auto send failed:', sendError?.message || 'Unknown auto-send error');
                          autoSendStatus = 'failed';
                        }
                      }
                    }
                  }
                }
              }
            } catch (draftError: any) {
              console.error('Auto draft creation failed:', draftError?.message || 'Unknown auto-draft error');
              autoDraftStatus = 'failed';
              autoDraftError = draftError?.message || 'Unknown error';
            }
          }

          // Send alert with accurate draft/send status
          const alertEventType = isUpdated ? 'api.lead_updated' : 'api.lead_added';
          await leadListAlertService.notifyLeadListOwnerIfConfigured(
            leadList,
            lead,
            alertEventType,
            {
              source: mergedCustomFields.source,
              forwardedAt: mergedCustomFields.forwardedAt,
              company: leadData.company,
              phone: leadData.phone,
              ...(autoDraftStatus ? { autoDraftStatus } : {}),
              ...(autoDraftError ? { autoDraftError } : {}),
              ...(autoSendStatus ? { autoSendStatus } : {}),
            },
            new Date().toISOString()
          );
        } catch (err) {
          console.error('Post-response processing error:', err);
        }
      })();
    }

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

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to forward lead'
    });
  }
});

// Queue for Fireflies transcript processing
const firefliesQueue: Array<{
  transcriptId: string;
  meetingTitle: string;
  receivedAt: string;
}> = [];

/**
 * POST /api/webhooks/fireflies
 * Receives Fireflies.ai webhook events when a transcript is ready.
 * Queues the transcript for action item extraction by the loop coordinator.
 */
router.post('/fireflies', (req: express.Request, res: express.Response) => {
  const { event_type, data } = req.body;

  if (!event_type) {
    res.status(400).json({ error: 'event_type is required' });
    return;
  }

  // Only process transcript-ready events
  if (event_type !== 'Transcription completed') {
    res.status(200).json({ status: 'ignored', event_type });
    return;
  }

  if (!data?.transcript_id) {
    res.status(400).json({ error: 'transcript_id is required in data' });
    return;
  }

  firefliesQueue.push({
    transcriptId: data.transcript_id,
    meetingTitle: data.meeting_title || 'Untitled Meeting',
    receivedAt: new Date().toISOString(),
  });

  res.status(200).json({
    status: 'queued',
    transcript_id: data.transcript_id,
  });
});

export function getFirefliesQueue() {
  return firefliesQueue;
}

export default router;
