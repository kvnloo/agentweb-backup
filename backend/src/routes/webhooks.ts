import * as crypto from 'crypto';
import express from 'express';
import { IncomingMessage } from 'http';
import { WebhookRequiredHeaders } from 'svix';
import { webhookService, ResendWebhookEvent } from '../services/webhookService';
import { emailEventsDb } from '../services/emailEventsDb';
import { leadListAlertService } from '../services/leadListAlertService';
import { crmDb, userDb, tempEmailDb } from '../services/db';
import { getUserIdByHubSpotPortalId } from '../services/connectedAccountsDb';
import { HubSpotService } from '../services/hubspotService';
import { getHubSpotConfig } from '../config/integrations';
import { externalCrmSyncService } from '../services/externalCrmSyncService';
import { agentModeService } from '../services/agentModeService';
import { resendService } from '../services/resendService';
import { emmaEmailService } from '../services/emmaEmailService';
import { TEMP_EMAIL_PREFIX, TEMP_EMAIL_DOMAIN } from '../config';
import { isDoNotContact } from '../utils/leadContactStatus';
import { normalizeAttribution } from '../types/attribution';

// ─── HubSpot signature helpers ────────────────────────────────────────────────

/**
 * Verifies a HubSpot v1 webhook signature.
 * HubSpot computes: SHA-256(clientSecret + rawBody) and sends it as hex in
 * the X-HubSpot-Signature header.
 * We re-stringify req.body (already JSON-parsed) which matches HubSpot's
 * canonical JSON in practice.
 */
function verifyHubSpotSignature(clientSecret: string, body: any, signature: string): boolean {
  try {
    const expected = crypto
      .createHash('sha256')
      .update(clientSecret + JSON.stringify(body))
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

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

      case 'email.bounced': {
        const bounceReason = event.data.bounce?.reason || 'Unknown reason';
        console.log(`Email bounced: ${event.data.email_id} - ${bounceReason}`);
        // Auto-flag bounced leads as do-not-contact
        const bouncedTo = Array.isArray(event.data.to) ? event.data.to : (event.data.to ? [event.data.to] : []);
        void (async () => {
          try {
            const users = await userDb.getUsersByEmailDomain(emailDomain);
            for (const user of users) {
              const lists = await crmDb.getLeadListsByUserId(user.userId);
              for (const list of (lists || [])) {
                for (const recipientEmail of bouncedTo) {
                  const lead = await crmDb.getLeadByEmail(list.listId, recipientEmail);
                  if (lead && !isDoNotContact(lead)) {
                    await crmDb.updateLead(list.listId, lead.leadId, {
                      contactStatus: 'do-not-contact',
                      contactStatusReason: 'bounced',
                      contactStatusNote: `Email bounced: ${bounceReason}`,
                      contactStatusUpdatedAt: new Date().toISOString(),
                      contactStatusUpdatedBy: 'system',
                      unsubscribedFromGroupEmail: true,
                      unsubscribedFromGroupEmailAt: new Date().toISOString(),
                    });
                    console.log(`Auto-flagged lead ${lead.leadId} in list ${list.listId} as do-not-contact (bounced)`);
                  }
                }
              }
            }
          } catch (err) {
            console.error('Error auto-flagging bounced lead:', err);
          }
        })();
        break;
      }

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
        // Store temp emails (test+xxxxxx@updates.agentweb.pro) for Emma to read
        const tempPrefix = `${TEMP_EMAIL_PREFIX}+`;
        const tempRecipients = toAddresses.filter((addr: any) => {
          const bare = addr.toLowerCase().replace(/^.*<|>.*$/g, '').trim();
          return bare.startsWith(tempPrefix) && bare.endsWith(`@${TEMP_EMAIL_DOMAIN}`);
        });
        if (tempRecipients.length > 0) {
          void (async () => {
            try {
              const emailContent = await resendService.getReceivedEmailContent(event.data.email_id);
              for (const recipient of tempRecipients) {
                const bare = recipient.toLowerCase().replace(/^.*<|>.*$/g, '').trim();
                await tempEmailDb.save({
                  emailId: event.data.email_id,
                  toAddress: bare,
                  fromAddress: event.data.from,
                  subject: event.data.subject || '',
                  text: emailContent?.text || emailContent?.html || '',
                  receivedAt: new Date().toISOString(),
                });
                console.log(`[TempEmail] Stored email ${event.data.email_id} for ${bare}`);
              }
            } catch (err) {
              console.error('[TempEmail] Failed to store:', err);
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
      customFields,
      attribution,
      utm,
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

    // Attribution — accept either the new `attribution` shape or the legacy
    // flat `utm` shape (same normaliser controllers/auth.ts uses for signup).
    // If the client sends nothing, we stamp nothing; the CSV import and other
    // internal paths won't carry attribution.
    const touch = normalizeAttribution(attribution) ?? normalizeAttribution(utm);
    if (touch) {
      leadData.firstTouch = touch;
      leadData.lastTouch = touch;
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// ATTIO WEBHOOK RECEIVER
//
// Attio sends events here for each user who has registered a webhook.
// The payload identifies the workspace via workspace_id — matched against
// connected accounts to find the user.
//
// Events handled:
//   record.created  → log for future sync (pull new person into leads)
//   record.updated  → log for future sync (update matching lead)
//   record.deleted  → log for future sync (flag lead as removed)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/attio', async (req: express.Request, res: express.Response) => {
  try {
    const event = req.body;
    const eventType: string = event?.event_type ?? event?.type ?? 'unknown';
    const workspaceId: string = event?.workspace_id ?? '';
    const objectType: string = event?.data?.object?.slug ?? '';
    const recordId: string = event?.data?.record?.id?.record_id ?? '';

    console.log(`[Attio Webhook] event=${eventType} object=${objectType} record=${recordId} workspace=${workspaceId}`);

    // Only process people and companies record events
    const isRelevantObject = objectType === 'people' || objectType === 'companies';
    const isRelevantEvent = ['record.created', 'record.updated', 'record.deleted'].includes(eventType);

    if (!isRelevantObject || !isRelevantEvent) {
      return res.status(200).json({ received: true, processed: false, reason: 'event not in scope' });
    }

    // TODO: Trigger sync handler when sync service is implemented
    // await attioSyncService.handleWebhookEvent(workspaceId, eventType, event.data);

    res.status(200).json({ received: true, processed: true });
  } catch (error: any) {
    console.error('[Attio Webhook] error:', error);
    res.status(200).json({ received: true, processed: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HUBSPOT WEBHOOK RECEIVER
//
// HubSpot sends events here for ALL connected portals (configured once in
// the HubSpot Developer Portal — not per user). Each event includes a
// portalId to identify which customer's data changed.
//
// To configure in HubSpot Developer Portal:
//   App Settings → Webhooks → Target URL → ${BACKEND_URL}/api/webhooks/hubspot
//   Subscribe to: contact.creation, contact.propertyChange, contact.deletion
//   For contact.propertyChange, watch: email, phone, firstname, lastname,
//   jobtitle, company, hs_linkedin_url
//
// Events handled:
//   contact.creation        → pull new contact into matching user's leads
//   contact.propertyChange  → update matching lead's fields
//   contact.deletion        → flag matching lead as removed
// ─────────────────────────────────────────────────────────────────────────────
router.post('/hubspot', (req: express.Request, res: express.Response) => {
  // Return 200 immediately — HubSpot retries on non-2xx or timeout.
  // All processing happens asynchronously (fire-and-forget).
  res.status(200).json({ received: true });

  void (async () => {
    try {
      // ── Signature verification ──────────────────────────────────────────────
      // Verify X-HubSpot-Signature when present. If the header is missing we
      // log a warning and continue (supports local dev / test environments).
      const signature = req.headers['x-hubspot-signature'] as string | undefined;
      if (signature) {
        const hubspotConfig = await getHubSpotConfig().catch(() => null);
        if (hubspotConfig?.clientSecret) {
          if (!verifyHubSpotSignature(hubspotConfig.clientSecret, req.body, signature)) {
            console.warn('[HubSpot Webhook] Signature mismatch — request ignored');
            return;
          }
        }
      } else {
        console.warn('[HubSpot Webhook] No X-HubSpot-Signature header — proceeding without verification');
      }

      // ── Aggregate events by objectId ────────────────────────────────────────
      const events: any[] = Array.isArray(req.body) ? req.body : [req.body];
      type ContactChange = {
        portalId: number;
        properties: Record<string, string>;
        isCreation: boolean;
        isDeleted: boolean;
      };
      const changesByObjectId: Record<string, ContactChange> = {};

      for (const event of events) {
        const eventType: string = event?.subscriptionType ?? 'unknown';
        const portalId: number = event?.portalId;
        const objectId: string = String(event?.objectId ?? '');
        const propertyName: string = event?.propertyName ?? '';
        const propertyValue: string = event?.propertyValue ?? '';

        console.log(`[HubSpot Webhook] event=${eventType} portal=${portalId} object=${objectId}${propertyName ? ` property=${propertyName}` : ''}`);

        const isRelevantEvent = ['contact.creation', 'contact.propertyChange', 'contact.deletion'].includes(eventType);
        if (!isRelevantEvent || !objectId) continue;

        if (!changesByObjectId[objectId]) {
          changesByObjectId[objectId] = { portalId, properties: {}, isCreation: false, isDeleted: false };
        }
        if (eventType === 'contact.creation') changesByObjectId[objectId].isCreation = true;
        if (eventType === 'contact.deletion') changesByObjectId[objectId].isDeleted = true;
        if (propertyName && propertyValue !== undefined) {
          changesByObjectId[objectId].properties[propertyName] = propertyValue;
        }
      }

      // ── Process each contact ────────────────────────────────────────────────
      for (const [objectId, data] of Object.entries(changesByObjectId)) {
        const userId = await getUserIdByHubSpotPortalId(data.portalId);
        if (!userId) {
          console.log(`[HubSpot Webhook] No user found for portal ${data.portalId}`);
          continue;
        }

        const svc = await HubSpotService.create(userId).catch(() => null);

        // For contact.creation: fetch full contact to populate all standard fields
        // (the creation event payload contains no property values).
        if (data.isCreation && svc) {
          try {
            const fullContact = await svc.getContactById(objectId);
            // Merge fetched properties; explicit webhook payload values take precedence
            Object.entries(fullContact).forEach(([k, v]) => {
              if (data.properties[k] === undefined && v) data.properties[k] = v;
            });
          } catch { /* non-fatal */ }
        }

        // Resolve email from payload or API fallback
        let email = data.properties.email;
        if (!email && svc) {
          try {
            const fetchedEmail = await svc.getContactEmailById(objectId);
            if (fetchedEmail) email = fetchedEmail;
          } catch { /* non-fatal — skip if token unavailable */ }
        }

        if (!email) {
          console.log(`[HubSpot Webhook] Could not determine email for contact ${objectId}, skipping`);
          continue;
        }

        const lists = await crmDb.getLeadListsByUserId(userId);
        if (!lists) continue;

        for (const list of lists) {
          // Check per-list webhook preference — skip if user has disabled webhook updates
          const syncConfig = await externalCrmSyncService.getConfig(userId, list.listId, 'hubspot').catch(() => null);
          if (syncConfig?.webhookEnabled === false) {
            console.log(`[HubSpot Webhook] webhookEnabled=false for list ${list.listId}, skipping`);
            continue;
          }

          const lead = await crmDb.getLeadByEmail(list.listId, email.toLowerCase());
          if (!lead) continue;

          if (data.isDeleted) {
            await crmDb.updateLead(list.listId, lead.leadId, {
              syncMetadata: { ...(lead.syncMetadata || {}), crmRemoved: true },
            });
            console.log(`[HubSpot Webhook] Marked lead ${lead.leadId} as CRM-removed`);
            continue;
          }

          const updates: any = {};
          if (data.properties.firstname    !== undefined) updates.firstName = data.properties.firstname;
          if (data.properties.lastname     !== undefined) updates.lastName  = data.properties.lastname;
          if (data.properties.phone        !== undefined) updates.phone     = data.properties.phone;
          if (data.properties.jobtitle     !== undefined) updates.title     = data.properties.jobtitle;
          if (data.properties.company      !== undefined) updates.company   = data.properties.company;
          if (data.properties.hs_linkedin_url !== undefined) updates.linkedin = data.properties.hs_linkedin_url;

          const standardHubspotProps = ['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url'];
          const customFieldUpdates: any = {};
          Object.entries(data.properties).forEach(([key, val]) => {
            if (standardHubspotProps.includes(key)) return;
            // Match existing custom field key using case-insensitive slug comparison
            let matchedKey = key;
            if (lead.customFields) {
              const found = Object.keys(lead.customFields).find(
                k => k.toLowerCase().replace(/[^a-z0-9]/g, '_') === key
              );
              if (found) matchedKey = found;
            }
            customFieldUpdates[matchedKey] = val;
          });

          if (Object.keys(customFieldUpdates).length > 0) {
            updates.customFields = { ...lead.customFields, ...customFieldUpdates };
          }

          if (Object.keys(updates).length > 0) {
            await crmDb.updateLead(list.listId, lead.leadId, updates);
            console.log(`[HubSpot Webhook] Synced updates to lead ${lead.leadId} in list ${list.listId}`);
          }
        }
      }
    } catch (error: any) {
      console.error('[HubSpot Webhook] error:', error);
    }
  })();
});

export default router;
